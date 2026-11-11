# archive — 이전 구현 (보관용)

지금 쓰는 구현은 `../src/core/` **하나**입니다. 이 폴더는 그 전에 만든 첫 번째 구현과, 그 구현에 묶인 학습 페이지를 **고치지 않고 그대로** 보관합니다.

| 경로 | 내용 |
|---|---|
| `src/` | 첫 번째 엔진: vdom · props · diff(patch 포함) · component · hooks · parseHTML · toHTML · domToVNode · history · mutationStats |
| `phase2-learn/` | 개념 학습 페이지: 엔진 안에서 일어난 일(`trace`)을 기록해 한 단계씩 재생. 코드 줄 강조가 이 폴더의 `src/` 줄 번호에 맞춰져 있어 함께 보관 |
| `test/` | 위 두 가지의 vitest 테스트 (할 일 앱 테스트는 앱과 함께 `../tests/todo.test.js`로 옮김) |

```bash
npm run test:archive      # 이 폴더의 테스트만 (vitest)
npm run serve             # http://127.0.0.1:8000/archive/phase2-learn/
```

## 새 구현(src/core)과 다른 점

| | archive/src (이전) | src/core (지금) |
|---|---|---|
| 리스트 비교 | 인덱스 기준만 (앞쪽을 지우면 뒤 항목이 모두 "바뀐 것") | key 기준 + LIS로 최소 MOVE |
| patch 종류 | CREATE · REMOVE · REPLACE · TEXT · PROPS | CREATE · REMOVE · REPLACE · UPDATE_TEXT · UPDATE_PROPS · MOVE |
| patch 적용 | 뒤에서부터 순서에 기대어 적용 | 경로를 먼저 노드 참조로 찾아 두고 3단계로 적용 |
| 엔진 기록 | `trace` 콜백 (학습 페이지용) | 없음 (`onRender`·`onPatch`만) |
| HTML 파서 | 직접 구현, 줄 번호 에러, SVG 지원 | 브라우저 `<template>` 사용, 루트 검사만 |

학습 페이지의 설명("엔진이 이 줄을 실행 중")은 **이전 엔진 기준**입니다. 개념(사물함, 배칭, effect 순서)은 지금 구현과 같습니다.
