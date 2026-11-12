package com.minidbms.engine;

import com.minidbms.common.ConstraintViolationException;
import com.minidbms.common.ParseException;
import com.minidbms.common.TypeMismatchException;
import com.minidbms.sql.parser.ast.Condition;
import com.minidbms.sql.parser.ast.InsertStatement;
import com.minidbms.sql.parser.ast.Literal;
import com.minidbms.sql.parser.ast.SelectStatement;
import com.minidbms.sql.parser.ast.Statement;
import com.minidbms.storage.Column;
import com.minidbms.storage.ColumnType;
import com.minidbms.storage.RecordCodec;
import com.minidbms.storage.Schema;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.function.Predicate;

/**
 * AST 문장을 스키마에 비춰 검증하고 실행한다. 파서가 미뤄둔 의미 검증(컬럼 존재·타입·개수)은 모두 여기서 한다.
 */
final class Executor {

    QueryResult execute(Statement statement, TableState table) {
        if (statement instanceof InsertStatement insert) {
            return insert(insert, table);
        }
        if (statement instanceof SelectStatement select) {
            return select(select, table);
        }
        throw new IllegalStateException("지원하지 않는 문장: " + statement);
    }

    // ---- INSERT ----

    private QueryResult insert(InsertStatement insert, TableState table) {
        Schema schema = table.schema();
        int[] targets = insertTargets(insert, table);

        // 지정하지 않은 컬럼은 NULL로 남는다.
        Object[] record = new Object[schema.size()];
        for (int i = 0; i < targets.length; i++) {
            record[targets[i]] = toStoredValue(insert.values().get(i), schema.column(targets[i]), schema);
        }
        // 검증이 모두 끝난 뒤에 id를 뽑는다. 실패한 INSERT가 id를 소모하지 않게 하려고.
        long id = table.nextId();
        record[table.idIndex()] = id;

        table.table().file().append(RecordCodec.encode(record));
        table.table().file().flush();
        // JDBC의 generated keys처럼 부여한 id를 결과 행으로 돌려준다.
        return new QueryResult(QueryResult.Type.INSERT, List.of(TableState.ID_COLUMN), List.of(List.of(id)), 1, 0);
    }

    /** values[i]가 들어갈 스키마 컬럼 인덱스를 돌려준다. */
    private int[] insertTargets(InsertStatement insert, TableState table) {
        Schema schema = table.schema();
        int valueCount = insert.values().size();

        if (insert.columns().isEmpty()) {
            // 컬럼을 생략하면 id를 뺀 스키마 순서대로 값을 받는다.
            int[] targets = new int[schema.size() - 1];
            for (int i = 0, t = 0; i < schema.size(); i++) {
                if (i != table.idIndex()) {
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
            if (index == table.idIndex()) {
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

    private QueryResult select(SelectStatement select, TableState table) {
        Schema schema = table.schema();
        // 스캔 전에 컬럼·조건을 모두 검증해서, 잘못된 쿼리가 파일을 끝까지 읽은 뒤에야 실패하지 않게 한다.
        int[] projection = projection(select, schema);
        Predicate<Object[]> filter = select.where().map(c -> compile(c, schema)).orElse(r -> true);

        List<List<Object>> rows = new ArrayList<>();
        table.table().file().scan(line -> {
            Object[] record = RecordCodec.decode(line, schema);
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
        return new QueryResult(QueryResult.Type.SELECT, columns, rows, rows.size(), 0);
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

        // NULL과의 비교는 결과가 항상 false다 (SQL의 3값 논리에서 UNKNOWN은 걸러진다).
        if (literal.isNull()) {
            return record -> false;
        }
        toStoredValue(literal, column, schema); // 타입이 다르면 TypeMismatchException

        Object expected = literal.value();
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
