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
import java.util.function.Predicate;

/**
 * AST 문장을 스키마에 비춰 검증하고 실행한다. 파서가 미뤄둔 의미 검증(컬럼 존재·타입·개수)은 모두 여기서 한다.
 */
final class Executor {
    static final List<String> EXPLAIN_COLUMNS = List.of("table", "access_path", "detail");

    private final Planner planner = new Planner();

    /**
     * @param maxRows  SELECT가 돌려줄 최대 행 수. 넘으면 그만 읽고 truncated로 표시한다.
     * @param maxBytes SELECT 결과의 대략적인 크기 상한(문자 수 기준). 넘으면 그만 읽고 truncated로 표시한다.
     * @param deadline 넘으면 읽기를 멈추고 QueryTimeoutException
     */
    QueryResult execute(Statement statement, Table table, boolean indexEnabled, long maxRows, long maxBytes,
                        Deadline deadline) {
        if (statement instanceof InsertStatement insert) {
            return insert(insert, table, deadline);
        }
        if (statement instanceof SelectStatement select) {
            return select(select, table, indexEnabled, maxRows, maxBytes, deadline);
        }
        if (statement instanceof ExplainStatement explain) {
            return explain(explain.select(), table, indexEnabled);
        }
        throw new IllegalStateException("지원하지 않는 문장: " + statement);
    }

    // ---- INSERT ----

    private QueryResult insert(InsertStatement insert, Table table, Deadline deadline) {
        Schema schema = table.schema();
        int[] targets = insertTargets(insert, table);

        // 지정하지 않은 컬럼은 NULL로 남는다.
        Object[] record = new Object[schema.size()];
        for (int i = 0; i < targets.length; i++) {
            record[targets[i]] = toStoredValue(insert.values().get(i), schema.column(targets[i]), schema);
        }
        // 검증이 모두 끝난 뒤에 id를 부여한다. 실패한 INSERT가 id를 소모하지 않게 하려고.
        // flush는 DatabaseEngine이 execute 호출 하나가 끝날 때 한 번 한다(INSERT마다 하면 쓰기 시스템 콜이 행 수만큼 생긴다).
        // 다른 요청이 테이블을 오래 읽고 있으면 쓰기 락을 마감 시각까지만 기다린다.
        long id = table.insert(record, deadline.remainingNanos());
        // JDBC의 generated keys처럼 부여한 id를 결과 행으로 돌려준다.
        return new QueryResult(QueryResult.Type.INSERT, List.of(Table.ID_COLUMN), List.of(List.of(id)), 1, null, 0, false);
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

    private QueryResult select(SelectStatement select, Table table, boolean indexEnabled, long maxRows, long maxBytes,
                               Deadline deadline) {
        Schema schema = table.schema();
        // 읽기 전에 컬럼·조건을 모두 검증해서, 잘못된 쿼리가 파일을 끝까지 읽은 뒤에야 실패하지 않게 한다.
        int[] projection = projection(select, schema);
        Predicate<Object[]> filter = select.where().map(c -> compile(c, schema)).orElse(r -> true);
        Plan plan = planner.plan(select, table, indexEnabled);

        // 몇 행까지 모을지 정한다. LIMIT이 최대 행 수 이하면 LIMIT만큼, 아니면 "최대 행 수 + 1"까지 모아서
        // 한 행이라도 넘치는지로 잘렸는지를 판단한다. 어느 쪽이든 그 수에 닿으면 남은 파일·범위를 읽지 않는다.
        long limit = select.limit().orElse(Long.MAX_VALUE);
        boolean capApplies = limit > maxRows;
        long collect = capApplies ? saturatedIncrement(maxRows) : limit;

        // 행 수와 별도로 결과 크기(대략적인 문자 수)도 센다. 같은 큰 컬럼을 수천 번 투영하면 한 행만으로도
        // 결과가 수백 MB가 될 수 있어서 행 수 제한만으로는 메모리를 지킬 수 없다.
        List<List<Object>> rows = new ArrayList<>();
        long[] bytes = {0};
        boolean[] overBudget = {false};
        if (collect > 0) {
            read(plan, table, deadline, record -> {
                // 인덱스 경로가 고른 레코드도 같은 필터를 한 번 더 통과시킨다.
                // 경로와 상관없이 "조건을 만족하는 행"의 정의가 한 곳(compile)에만 있게 하려고.
                if (filter.test(record)) {
                    long rowBytes = 0;
                    for (int index : projection) {
                        rowBytes += estimatedSize(record[index]);
                    }
                    if (rowBytes > maxBytes - bytes[0]) {
                        overBudget[0] = true; // 이 행은 넣지 않고 멈춘다
                        return false;
                    }
                    bytes[0] += rowBytes;
                    Object[] row = new Object[projection.length];
                    for (int i = 0; i < projection.length; i++) {
                        row[i] = record[projection[i]];
                    }
                    rows.add(Collections.unmodifiableList(Arrays.asList(row)));
                }
                return rows.size() < collect; // false면 읽기를 멈춘다
            });
        }
        boolean truncated = overBudget[0] || (capApplies && rows.size() > maxRows);
        if (capApplies && rows.size() > maxRows) {
            rows.remove(rows.size() - 1); // 넘침을 확인하려고 하나 더 읽은 행
        }

        List<String> columns = new ArrayList<>();
        for (int index : projection) {
            columns.add(schema.column(index).name());
        }
        return new QueryResult(QueryResult.Type.SELECT, columns, rows, rows.size(), plan.path(), 0, truncated);
    }

    private static long saturatedIncrement(long n) {
        return n == Long.MAX_VALUE ? n : n + 1;
    }

    /**
     * 계획에 따라 후보 레코드를 넘긴다. 인덱스 경로는 id 순서, FULL_SCAN은 파일 순서다.
     * visitor가 false를 돌려주면 그 자리에서 멈춘다.
     *
     * <p>후보를 {@link Deadline#CHECK_EVERY_ROWS}개 읽을 때마다 마감 시각을 확인한다. 조건에 맞는 행이 아니라
     * 읽은 행 기준이라, 결과는 0행인데 전체를 훑는 쿼리도 제때 멈춘다. 예외는 Table의 읽기 락과 파일 스트림을
     * finally로 정리하며 빠져나간다.
     */
    /**
     * 결과 값 하나가 응답(JSON·표)에서 차지할 대략적인 크기. 문자열은 길이 + 따옴표, 숫자는 최대 자릿수, NULL은 4.
     * 정확한 직렬화 크기가 아니라 "수백 MB짜리 결과를 만들기 전에 멈춘다"는 목적의 상한 추정이다.
     */
    static long estimatedSize(Object value) {
        if (value instanceof String s) {
            return s.length() + 2L;
        }
        return value == null ? 4 : 20;
    }

    private static void read(Plan plan, Table table, Deadline deadline, Predicate<Object[]> visitor) {
        if (plan.isEmptyRange()) {
            return;
        }
        deadline.check();
        if (!deadline.isUnlimited()) {
            Predicate<Object[]> inner = visitor;
            int[] seen = {0};
            visitor = record -> {
                if (++seen[0] % Deadline.CHECK_EVERY_ROWS == 0) {
                    deadline.check();
                }
                return inner.test(record);
            };
        }
        // 락을 기다리는 시간도 마감 시각 안에 둔다. 다른 INSERT가 쓰기 락을 오래 쥐고 있을 때
        // 단건 조회(행 검사가 한 번도 일어나지 않음)가 제한 시간을 넘겨 기다린 뒤 성공하는 일을 막는다.
        long lockTimeout = deadline.remainingNanos();
        switch (plan.path()) {
            case INDEX_LOOKUP -> table.findById(plan.low(), lockTimeout).ifPresent(visitor::test);
            case INDEX_RANGE -> table.rangeByIdWhile(plan.low(), plan.high(), visitor, lockTimeout);
            case FULL_SCAN -> table.scanWhile(visitor, lockTimeout);
        }
    }

    private QueryResult explain(SelectStatement select, Table table, boolean indexEnabled) {
        // 실제 SELECT와 같은 검증을 거친다. 실행했다면 실패할 쿼리를 EXPLAIN이 통과시키지 않게.
        projection(select, table.schema());
        select.where().ifPresent(c -> compile(c, table.schema()));
        Plan plan = planner.plan(select, table, indexEnabled);
        String detail = plan.detail() + (select.limit().isPresent() ? ", LIMIT " + select.limit().getAsLong() : "");
        List<Object> row = List.of(table.name(), plan.path().name(), detail);
        return new QueryResult(QueryResult.Type.EXPLAIN, EXPLAIN_COLUMNS, List.of(row), 0, plan.path(), 0, false);
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
        if (a instanceof String x && b instanceof String y) {
            return compareCodePoints(x, y);
        }
        return ((Comparable<Object>) a).compareTo(b);
    }

    /**
     * 유니코드 코드 포인트 순서로 비교한다. String.compareTo는 UTF-16 코드 단위를 비교해서, 보충 문자(U+10000 이상,
     * 서로게이트 쌍 0xD800~)가 U+E000~U+FFFF보다 작다고 판단한다. README에 적은 "코드 포인트 순"과 맞추려고 직접 비교한다.
     */
    static int compareCodePoints(String x, String y) {
        int i = 0;
        int j = 0;
        while (i < x.length() && j < y.length()) {
            int a = x.codePointAt(i);
            int b = y.codePointAt(j);
            if (a != b) {
                return Integer.compare(a, b);
            }
            i += Character.charCount(a);
            j += Character.charCount(b);
        }
        return Boolean.compare(i < x.length(), j < y.length());
    }

    private static String describe(Literal literal) {
        return (literal.value() instanceof Long ? "INT " : "STRING ") + literal;
    }

    private static String columnNames(Schema schema, int[] indexes) {
        return String.join(", ", Arrays.stream(indexes).mapToObj(i -> schema.column(i).name()).toList());
    }
}
