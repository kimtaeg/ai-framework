package com.minidbms.bench;

import java.util.Random;

/**
 * users 테이블용 무작위 행을 INSERT SQL로 만든다. 같은 seed면 항상 같은 순서로 같은 데이터가 나온다.
 *
 * <ul>
 *   <li>name: 소문자 5~10자 무작위 문자열</li>
 *   <li>age: 1~100</li>
 *   <li>email: "user{n}@test.com" — n이 행 번호라 항상 고유하다</li>
 * </ul>
 */
final class UserRowGenerator {
    static final String COLUMNS = "(name, age, email)";

    private final String table;
    private final Random random;

    UserRowGenerator(String table, long seed) {
        this.table = table;
        this.random = new Random(seed);
    }

    /**
     * n번째 행의 INSERT 문장을 sql 뒤에 붙인다(끝에 ';').
     * 문장마다 새 String을 만들지 않고 호출자의 StringBuilder에 바로 쓴다. 100만 번 도는 경로라 임시 문자열을 줄인다.
     */
    void appendInsert(StringBuilder sql, long n) {
        sql.append("INSERT INTO ").append(table).append(' ').append(COLUMNS).append(" VALUES ('");
        int length = 5 + random.nextInt(6);
        for (int i = 0; i < length; i++) {
            sql.append((char) ('a' + random.nextInt(26)));
        }
        // 이름은 a~z만 쓰므로 작은따옴표 이스케이프가 필요 없다.
        sql.append("', ").append(1 + random.nextInt(100))
                .append(", 'user").append(n).append("@test.com');");
    }
}
