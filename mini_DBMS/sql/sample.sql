-- 미니 DBMS 예제
-- 실행: java -jar build/libs/mini-dbms.jar run sql/sample.sql --data ./data

INSERT INTO users VALUES ('kim', 30);
INSERT INTO users VALUES ('lee', 25);
INSERT INTO users (age, name) VALUES (41, '박정글');   -- 컬럼 순서를 바꿔도 된다
INSERT INTO users (name) VALUES ('no-age');           -- 지정하지 않은 컬럼은 NULL
INSERT INTO users VALUES ('o''brien; | \ 특수문자', 19);

SELECT * FROM users;
SELECT name, age FROM users WHERE age >= 30;
SELECT name FROM users WHERE age != 30;               -- NULL은 어떤 비교에서도 false

-- 아래는 일부러 넣은 오류. 오류를 출력하고 다음 문장을 계속 실행한다.
INSERT INTO users VALUES ('typo', 'thirty');
SELECT nickname FROM users;

SELECT id, name FROM users WHERE name = 'kim'
