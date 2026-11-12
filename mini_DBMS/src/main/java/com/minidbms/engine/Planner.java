package com.minidbms.engine;

import com.minidbms.sql.parser.ast.Condition;
import com.minidbms.sql.parser.ast.Literal;
import com.minidbms.sql.parser.ast.Operator;
import com.minidbms.sql.parser.ast.SelectStatement;
import com.minidbms.storage.Table;

/**
 * SELECT의 실행 경로를 고른다. 인덱스는 id 하나에만 있으므로 규칙은 단순하다.
 * <ul>
 *   <li>WHERE id = v → INDEX_LOOKUP</li>
 *   <li>WHERE id &lt;, &lt;=, &gt;, &gt;=, BETWEEN → INDEX_RANGE (닫힌 구간 [low, high]로 바꾼다)</li>
 *   <li>그 외(조건 없음, id가 아닌 컬럼, id != v, 인덱스 꺼짐) → FULL_SCAN</li>
 * </ul>
 * 조건의 컬럼·타입 검증은 Executor가 먼저 끝낸 상태라고 가정한다.
 */
final class Planner {

    Plan plan(SelectStatement select, Table table, boolean indexEnabled) {
        if (select.where().isEmpty()) {
            return Plan.fullScan("WHERE 없음");
        }
        Condition condition = select.where().get();
        if (table.schema().indexOf(condition.column()) != table.idColumn()) {
            return Plan.fullScan("'" + condition.column() + "'에는 인덱스가 없음, 조건: " + condition);
        }
        if (!indexEnabled) {
            return Plan.fullScan("인덱스 사용 꺼짐, 조건: " + condition);
        }

        String reason = condition.toString();
        // id = NULL 같은 NULL 비교는 항상 false이므로 빈 범위로 만든다(인덱스에는 NULL id가 없다).
        if (condition.value().isNull() || (condition.high() != null && condition.high().isNull())) {
            return emptyRange(condition, reason);
        }
        long v = asLong(condition.value());
        return switch (condition.operator()) {
            case EQ -> new Plan(AccessPath.INDEX_LOOKUP, v, v, reason);
            case NEQ -> Plan.fullScan("!= 는 범위 하나로 표현할 수 없음, 조건: " + reason);
            // 정수 키이므로 열린 경계는 ±1로 닫는다. Long 끝값에서는 넘치지 않게 빈 범위로 처리한다.
            case LT -> v == Long.MIN_VALUE ? emptyRange(condition, reason) : range(Long.MIN_VALUE, v - 1, reason);
            case LTE -> range(Long.MIN_VALUE, v, reason);
            case GT -> v == Long.MAX_VALUE ? emptyRange(condition, reason) : range(v + 1, Long.MAX_VALUE, reason);
            case GTE -> range(v, Long.MAX_VALUE, reason);
            case BETWEEN -> range(v, asLong(condition.high()), reason);
        };
    }

    private static Plan range(long low, long high, String reason) {
        return new Plan(AccessPath.INDEX_RANGE, low, high, reason);
    }

    private static Plan emptyRange(Condition condition, String reason) {
        AccessPath path = condition.operator() == Operator.EQ
                ? AccessPath.INDEX_LOOKUP : AccessPath.INDEX_RANGE;
        return new Plan(path, 1, 0, reason);
    }

    private static long asLong(Literal literal) {
        return (Long) literal.value();
    }
}
