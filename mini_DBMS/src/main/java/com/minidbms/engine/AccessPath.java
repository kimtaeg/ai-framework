package com.minidbms.engine;

/** SELECT가 레코드를 찾아가는 방법 */
public enum AccessPath {
    /** WHERE id = ? : B+ 트리에서 키 하나를 찾고 그 offset의 줄만 읽는다. */
    INDEX_LOOKUP("index lookup"),
    /** WHERE id 범위 : 하한 리프까지 내려간 뒤 리프 연결을 따라 상한까지 읽는다. */
    INDEX_RANGE("index range"),
    /** 그 외 : 파일 전체를 읽으며 조건을 검사한다. */
    FULL_SCAN("full scan");

    private final String label;

    AccessPath(String label) {
        this.label = label;
    }

    /** CLI 출력용 이름 */
    public String label() {
        return label;
    }
}
