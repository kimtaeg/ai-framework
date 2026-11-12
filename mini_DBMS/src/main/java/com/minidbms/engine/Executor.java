package com.minidbms.engine;

import com.minidbms.common.ConstraintViolationException;
import com.minidbms.common.ParseException;
import com.minidbms.common.TypeMismatchException;
import com.minidbms.sql.parser.ast.Condition;
import com.minidbms.sql.parser.ast.ExplainStatement;
import com.minidbms.sql.parser.ast.InsertStatement;
import com.minidbms.sql.parser.ast.Literal;
import com.minidbms.sql.parser.ast.SelectStatement;
import com.minidbms.sql.parser.ast.Statement;
import com.minidbms.storage.Column;
import com.minidbms.storage.ColumnType;
import com.minidbms.storage.Schema;
import com.minidbms.storage.Table;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * AST 문장을 스키마에 비춰 검증하고 실행한다. 파서가 미뤄둔 의미 검증(컬럼 존재·타입·개수)은 모두 여기서 한다.
 */
final class Executor {
    static final List<String> EXPLAIN_COLUMNS = List.of("table", "access_path", "detail");

    private final Planner planner = new Planner();

    QueryResult execute(Statement statement, Table table, boolean indexEnabled) {
        if (statement instanceof InsertStatement insert) {
            return insert(insert, table);
        }
        if (statement instanceof SelectStatement select) {
            return select(select, table, indexEnabled);
        }
        if (statement instanceof ExplainStatement explain) {
            return explain(explain.select(), table, indexEnabled);
        }
        throw new IllegalStateException("지원하지 않는 문장: " + statement);
    }

    // ---- INSERT ----

    private QueryResult insert(InsertStatement insert, Table table) {
        Schema schema = table.schema();
        int[] targets = insertTargets(insert, table);

        // 지정하지 않은 컬럼은 NULL로 남는다.
        Object[] record = new Object[schema.size()];
        for (int i = 0; i < targets.length; i++) {
            record[targets[i]] = toStoredValue(insert.values().get(i), schema.column(targets[i]), schema);
        }
        // 검증이 모두 끝난 뒤에 id를 부여한다. 실패한 INSERT가 id를 소모하지 않게 하려고.
        long id = table.insert(record);
        table.flush();
        // JDBC의 generated keys처럼 부여한 id를 결과 행으로 돌려준다.
        return new QueryResult(QueryResult.Type.INSERT, List.of(Table.ID_COLUMN), List.of(List.of(id)), 1, null, 0);
    }

    /** values[i]가 들어갈 스키마 컬럼 인덱스를 돌려준다. */
    private int[] insertTargets(InsertStatement insert, Table table) {
        Schema schema = table.schema();
        int valueCount = insert.values().size();

        if (insert.columns().isEmpty()) {
            // 컬럼을 생략하면 id를 뺀 스키마 순서대로 값을 받는다.
            int[] targets = new int[schema.size() - 1];
            for (int i = 0, t = 0; i < schema.size(); i++) {
                if (i != table.idColumn()) {
                    targets[t++] = i;
                }
            }
            if (valueCount != targets.length) {
                throw new ParseException("테이블 '" + schema.tableName() + "'에는 id를 뺀 값 " + targets.length
                        + "개가 필요한데 " + valueCount + "개가 주어졌습니다 (순서: " + columnNames(schema, targets) + ")");
            }
            return targets;
        }

        int[] targets = new int[insert.columns().size()];
        boolean[] seen = new boolean[schema.size()];
        for (int i = 0; i < targets.length; i++) {
            String name = insert.columns().get(i);
            int index = schema.indexOf(name); // 없는 컬럼이면 ColumnNotFoundException
            if (index == table.idColumn()) {
                throw new ConstraintViolationException("id는 자동으로 부여되므로 직접 넣을 수 없습니다 (테이블 '"
                        + schema.tableName() + "')");
            }
            if (seen[index]) {
                throw new ParseException("컬럼 '" + name + "'이(가) INSERT 컬럼 목록에 두 번 나옵니다");
            }
            seen[index] = true;
            targets[i] = index;
        }
        // 컬럼 목록이 있으면 개수는 Parser가 이미 맞춰 두었다.
        return targets;
    }

    private static Object toStoredValue(Literal literal, Column column, Schema schema) {
        if (literal.isNull()) {
            return null;
        }
        Object value = literal.value();
        boolean ok = column.type() == ColumnType.INT ? value instanceof Long : value instanceof String;
        if (!ok) {
            throw new TypeMismatchException("컬럼 '" + schema.tableName() + "." + column.name() + "'은(는) "
                    + column.type() + " 타입인데 " + describe(literal) + " 값이 주어졌습니다");
        }
        return value;
    }

    // ---- SELECT ----

    private QueryResult select(SelectStatement select, Table table, boolean indexEnabled) {
        Schema schema = table.schema();
        // 읽기 전에 컬럼·조건을 모두 검증해서, 잘못된 쿼리가 파일을 끝까지 읽은 뒤에야 실패하지 않게 한다.
        int[] projection = projection(select, schema);
        Predicate<Object[]> filter = select.where().map(c -> compile(c, schema)).orElse(r -> true);
        Plan plan = planner.plan(select, table, indexEnabled);

        List<List<Object>> rows = new ArrayList<>();
        read(plan, table, record -> {
            // 인덱스 경로가 고른 레코드도 같은 필터를 한 번 더 통과시킨다.
            // 경로와 상관없이 "조건을 만족하는 행"의 정의가 한 곳(compile)에만 있게 하려고.
            if (filter.test(record)) {
                Object[] row = new Object[projection.length];
                for (int i = 0; i < projection.length; i++) {
                    row[i] = record[projection[i]];
                }
                rows.add(Collections.unmodifiableList(Arrays.asList(row)));
            }
        });

        List<String> columns = new ArrayList<>();
        for (int index : projection) {
            columns.add(schema.column(index).name());
        }
        return new QueryResult(QueryResult.Type.SELECT, columns, rows, rows.size(), plan.path(), 0);
    }

    /** 계획에 따라 후보 레코드를 넘긴다. 인덱스 경로는 id 순서, FULL_SCAN은 파일 순서다. */
    private static void read(Plan plan, Table table, Consumer<Object[]> consumer) {
        if (plan.isEmptyRange()) {
            return;
        }
        switch (plan.path()) {
            case INDEX_LOOKUP -> table.findById(plan.low()).ifPresent(consumer);
            case INDEX_RANGE -> table.rangeById(plan.low(), plan.high(), consumer);
            case FULL_SCAN -> table.scan(consumer);
        }
    }

    private QueryResult explain(SelectStatement select, Table table, boolean indexEnabled) {
        // 실제 SELECT와 같은 검증을 거친다. 실행했다면 실패할 쿼리를 EXPLAIN이 통과시키지 않게.
        projection(select, table.schema());
        select.where().ifPresent(c -> compile(c, table.schema()));
        Plan plan = planner.plan(select, table, indexEnabled);
        List<Object> row = List.of(table.name(), plan.path().name(), plan.detail());
        return new QueryResult(QueryResult.Type.EXPLAIN, EXPLAIN_COLUMNS, List.of(row), 0, plan.path(), 0);
    }

    private static int[] projection(SelectStatement select, Schema schema) {
        if (select.selectsAll()) {
            int[] all = new int[schema.size()];
            Arrays.setAll(all, i -> i);
            return all;
        }
        return select.columns().stream().mapToInt(schema::indexOf).toArray();
    }

    /** WHERE 조건을 레코드 판정 함수로 바꾼다. 컬럼 위치와 타입 검사는 행마다가 아니라 한 번만 한다. */
    private static Predicate<Object[]> compile(Condition condition, Schema schema) {
        int index = schema.indexOf(condition.column());
        Column column = schema.column(index);
        Literal literal = condition.value();

        Literal high = condition.high();
        // 타입이 다르면 TypeMismatchException. NULL은 타입 검사를 통과한다.
        toStoredValue(literal, column, schema);
        if (high != null) {
            toStoredValue(high, column, schema);
        }
        // NULL과의 비교는 결과가 항상 false다 (SQL의 3값 논리에서 UNKNOWN은 걸러진다).
        if (literal.isNull() || (high != null && high.isNull())) {
            return record -> false;
        }

        Object expected = literal.value();
        Object upper = high == null ? null : high.value();
        return record -> {
            Object actual = record[index];
            if (actual == null) {
                return false;
            }
            int cmp = compare(actual, expected);
            return switch (condition.operator()) {
                case EQ -> cmp == 0;
                case NEQ -> cmp != 0;
                case LT -> cmp < 0;
                case LTE -> cmp <= 0;
                case GT -> cmp > 0;
                case GTE -> cmp >= 0;
                case BETWEEN -> cmp >= 0 && compare(actual, upper) <= 0;
            };
        };
    }

    @SuppressWarnings("unchecked")
    private static int compare(Object a, Object b) {
        // 타입은 compile에서 이미 맞춰 두었으므로 둘은 같은 타입(Long 또는 String)이다.
        return ((Comparable<Object>) a).compareTo(b);
    }

    private static String describe(Literal literal) {
        return (literal.value() instanceof Long ? "INT " : "STRING ") + literal;
    }

    private static String columnNames(Schema schema, int[] indexes) {
        return String.join(", ", Arrays.stream(indexes).mapToObj(i -> schema.column(i).name()).toList());
    }
}
