package com.minidbms.server;

import com.minidbms.common.ColumnNotFoundException;
import com.minidbms.common.ConstraintViolationException;
import com.minidbms.common.DbException;
import com.minidbms.common.DuplicateKeyException;
import com.minidbms.common.ParseException;
import com.minidbms.common.QueryTimeoutException;
import com.minidbms.common.StorageException;
import com.minidbms.common.TableNotFoundException;
import com.minidbms.common.TypeMismatchException;

import java.util.Map;

/**
 * 예외 → HTTP 상태 코드 + error code 문자열.
 *
 * <pre>
 * ParseException                 400 PARSE_ERROR           SQL 문법, 값 개수, 컬럼 중복
 * ColumnNotFoundException        400 COLUMN_NOT_FOUND
 * TypeMismatchException          400 TYPE_MISMATCH
 * TableNotFoundException         404 TABLE_NOT_FOUND
 * ConstraintViolationException   409 CONSTRAINT_VIOLATION  id 직접 지정
 * DuplicateKeyException          409 DUPLICATE_KEY
 * QueryTimeoutException          503 QUERY_TIMEOUT         제한 시간 초과 (같은 쿼리를 다시 보내도 같으므로 Retry-After 없음)
 * StorageException               500 STORAGE_ERROR         파일 I/O·손상 (서버 로그)
 * 그 외 DbException              500 DB_ERROR              (서버 로그)
 * ApiException                   그 예외의 상태·코드        HTTP 요청 오류
 * 그 외 모든 예외                500 INTERNAL_ERROR        메시지는 감추고 서버 로그에 스택 트레이스
 * </pre>
 * 4xx는 클라이언트가 고칠 수 있는 오류라 메시지를 그대로 돌려준다(SQL·스키마 이름 같은 도메인 정보만 담긴다).
 * 5xx는 메시지에 파일 경로나 저장된 레코드 내용이 들어갈 수 있으므로 고정 문구만 응답하고, 원문은 서버 로그에만 남긴다.
 */
final class ErrorMapper {
    /** @param serverFault true면 서버 로그에 스택 트레이스를 남긴다 */
    record ApiError(int status, String code, String message, Map<String, String> headers, boolean serverFault) {
        Map<String, Object> body() {
            return Json.error(code, message);
        }
    }

    static final String INTERNAL_MESSAGE = "서버 내부 오류가 발생했습니다. 서버 로그를 확인하세요";
    static final String STORAGE_MESSAGE = "저장소 오류가 발생했습니다(파일 I/O 또는 데이터 손상). 서버 로그를 확인하세요";

    private ErrorMapper() {
    }

    static ApiError map(Throwable error) {
        if (error instanceof ApiException api) {
            return new ApiError(api.status(), api.code(), api.getMessage(), api.headers(), false);
        }
        // 하위 타입을 먼저 검사한다(모두 DbException의 자식이다).
        if (error instanceof ParseException) {
            return client(400, "PARSE_ERROR", error);
        }
        if (error instanceof ColumnNotFoundException) {
            return client(400, "COLUMN_NOT_FOUND", error);
        }
        if (error instanceof TypeMismatchException) {
            return client(400, "TYPE_MISMATCH", error);
        }
        if (error instanceof TableNotFoundException) {
            return client(404, "TABLE_NOT_FOUND", error);
        }
        if (error instanceof ConstraintViolationException) {
            return client(409, "CONSTRAINT_VIOLATION", error);
        }
        if (error instanceof DuplicateKeyException) {
            return client(409, "DUPLICATE_KEY", error);
        }
        if (error instanceof QueryTimeoutException) {
            // 서버 결함이 아니라 설정한 한도에 걸린 것이므로 스택 트레이스는 남기지 않는다(요청 로그에 503으로 보인다).
            return client(503, "QUERY_TIMEOUT", error);
        }
        if (error instanceof StorageException) {
            return new ApiError(500, "STORAGE_ERROR", STORAGE_MESSAGE, Map.of(), true);
        }
        if (error instanceof DbException) {
            return new ApiError(500, "DB_ERROR", INTERNAL_MESSAGE, Map.of(), true);
        }
        // 예상하지 못한 예외(NPE 등)의 메시지는 내부 구현을 드러낼 수 있어 클라이언트에는 감춘다.
        return new ApiError(500, "INTERNAL_ERROR", INTERNAL_MESSAGE, Map.of(), true);
    }

    private static ApiError client(int status, String code, Throwable error) {
        return new ApiError(status, code, error.getMessage(), Map.of(), false);
    }
}
