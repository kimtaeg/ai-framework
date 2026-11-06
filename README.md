# Mini React · Phase 1 — Virtual DOM Diff & Patch

외부 라이브러리 없이 Virtual DOM을 직접 만들고, **바뀐 부분만 실제 DOM에 반영(patch)** 하는 과정을
눈으로 확인하는 검증 페이지까지 구현한 프로젝트입니다. (크래프톤 정글 11~12주차)

- HTML을 고치고 **Patch** → 이전 VNode와 diff → 실제 영역에 바뀐 부분만 반영
- **뒤로/앞으로** → 기록 사이를 diff/patch로 이동
- **MutationObserver**로 실제 DOM 변경 수를 세어, 같은 변경을 `innerHTML`로 했을 때와 비교

## 실행 방법

```bash
npm install        # 테스트 도구(vitest, jsdom) 설치
npm test           # 단위 테스트 전체 실행
npm run test:watch # 파일 저장 시마다 테스트

npm run serve      # http://localhost:8000/phase1/ 접속
```

> ES 모듈(`import`)은 `file://`로 열면 브라우저가 막습니다. 반드시 HTTP 서버로 여세요.
> textarea에서 `Cmd/Ctrl + Enter`로도 Patch할 수 있습니다.

## 폴더 구조

```
ai-framework/
├── src/                    # Virtual DOM 코어 (브라우저·테스트 공용, 외부 의존성 없음)
│   ├── vdom.js             # VNode 모양, h(), render() (SVG 네임스페이스 포함)
│   ├── props.js            # setProp / removeProp / updateProps — 속성·프로퍼티 반영의 단일 창구
│   ├── diff.js             # diff(old, new) → patch 목록, patch(container, patches) → 실제 DOM 반영
│   ├── domToVNode.js       # 실제 DOM → VNode
│   ├── parseHTML.js        # HTML 문자열 → VNode (태그 짝·중첩 규칙 검사, 줄 번호 에러)
│   ├── toHTML.js           # VNode → 들여쓴 HTML 문자열
│   ├── history.js          # 뒤로/앞으로 기록 (배열 + 현재 인덱스)
│   └── mutationStats.js    # MutationRecord → 추가/삭제/속성/텍스트 변경 수
├── phase1/                 # 검증 페이지
│   ├── index.html          # 실제 영역 · 테스트 영역 · 비교 패널 · patch 목록 · 로그
│   ├── style.css           # 라이트/다크, 모바일 대응
│   └── main.js             # 화면 동작 연결
├── test/                   # vitest + jsdom 단위 테스트 (80개)
└── docs/
    └── presentation-qna.md # 발표 예상 질문과 답변
```

### 데이터 흐름

```
[로드]   실제 영역 DOM ─toVNode→ v1 ─→ history [v1]
                                  └→ toHTML → textarea,  render → 미리보기

[입력]   textarea ─parseHTML→ VNode ─render→ 미리보기         (실제 영역은 그대로)

[Patch]  textarea ─parseHTML→ next
         diff(history.current(), next) → patches
         patch(실제 영역, patches)      ← MutationObserver가 변경 수를 셈
         history.push(next) → patch 목록 · 비교 패널 · 로그 갱신

[뒤로]   prev = current, next = history.back()
         diff(prev, next) → patch(실제 영역) → textarea·미리보기도 next로
```

## 핵심 개념

### 1. 브라우저 렌더링과 Reflow · Repaint

브라우저는 HTML/CSS를 화면에 그리기까지 다음 단계를 거칩니다.

```
DOM + CSSOM → Render Tree → Layout(Reflow) → Paint(Repaint) → Composite
```

| 단계 | 하는 일 | 다시 일어나는 때 (예) |
|---|---|---|
| **Reflow** (Layout) | 각 요소의 **위치와 크기**를 계산 | 노드 추가·삭제, 텍스트 변경, `width`·`font-size`·`display` 변경, `offsetHeight` 읽기 |
| **Repaint** (Paint) | 계산된 박스에 **색·그림자·글자**를 칠함 | `color`, `background`, `visibility` 변경 |

- Reflow가 일어나면 Repaint도 따라옵니다. 반대로 색만 바꾸면 Repaint만 일어납니다.
- 한 요소의 크기가 바뀌면 형제·부모·자식까지 다시 계산될 수 있어 **Reflow가 가장 비싼 단계**입니다.
- 그래서 DOM 조작은 **적게, 모아서** 하는 것이 좋습니다. Virtual DOM은 이것을 자동으로 해 주는 장치입니다.

### 2. Virtual DOM

실제 DOM을 흉내 낸 **가벼운 JS 객체 트리**입니다.

```js
// <li class="todo__item">VNode 설계</li>
{ type: 'li', props: { class: 'todo__item' }, children: ['VNode 설계'] }
```

1. 화면이 어떻게 생겨야 하는지를 VNode로 새로 만든다. (JS 객체라 만들고 버리기가 싸다)
2. 이전 VNode와 **diff** 해서 달라진 점만 patch 목록으로 뽑는다.
3. 그 목록만 실제 DOM에 **patch** 한다. (비싼 DOM 조작을 최소화)

개발자는 "최종 모습"만 선언하고, "어떻게 바꿀지"는 diff/patch가 계산합니다.

### 3. Diff 5가지 케이스

`src/diff.js`는 두 트리를 같은 위치(path)끼리 재귀 비교해 아래 5가지 patch를 만듭니다.
path는 루트에서 자식 인덱스를 따라간 경로입니다. (`[2, 0]` = 루트의 2번째 자식의 0번째 자식)

| 케이스 | 조건 | 실제 DOM 조작 | 데모 예시 |
|---|---|---|---|
| **CREATE** | 이전엔 없고 새로 생김 | `insertBefore(render(vnode))` | `<li>` 추가 |
| **REMOVE** | 이전엔 있고 새엔 없음 | `node.remove()` | `<a>` 삭제 |
| **REPLACE** | 태그 종류가 다름 (또는 텍스트 ↔ 요소) | `replaceWith(render(vnode))` | `<strong>` → `<em>` |
| **TEXT** | 둘 다 텍스트인데 내용이 다름 | `nodeValue = 새 텍스트` | 제목 수정 |
| **PROPS** | 같은 태그인데 속성이 다름 | `updateProps` (추가·변경·삭제) | `class`, `checked` 변경 |

자식 비교 규칙 (인덱스 기준):

```
공통 길이까지   → 같은 인덱스끼리 재귀 비교
새 쪽이 더 길면 → 뒤에 CREATE
옛 쪽이 더 길면 → 뒤에서부터 REMOVE (앞쪽 인덱스가 밀리지 않도록)
```

#### attribute와 property

`value`, `checked`, `selected`는 HTML 속성(attribute, 초기값)과 DOM 프로퍼티(property, 현재 화면 값)가
사용자 입력 이후 따로 움직입니다. `setProp`은 둘 다 맞추고, `key`와 `on*` prop은 DOM에 그리지 않습니다.

### 4. MutationObserver로 본 patch vs innerHTML

같은 변경을 두 방식으로 적용했을 때 바뀐 노드 수 (샘플 카드 = 노드 21개):

| 변경 | patch | innerHTML |
|---|---|---|
| 제목 텍스트 수정 | **1** | 42 |
| `<li>` 추가 / `<a>` 삭제 | **2** | 44 |
| `<strong>` → `<em>` | **4** | 42 |
| `class` + `checked` 변경 | **2** | 42 |
| 변경 없음 | **0** | 42 |

innerHTML은 무엇이 바뀌었는지 모르기 때문에 매번 **전부 지우고 전부 새로 만듭니다**(비용 ∝ 화면 크기).
patch는 **바뀐 만큼만** 고칩니다(비용 ∝ 변경 크기). 노드가 유지되므로 포커스·입력값·이벤트 리스너도 보존됩니다.

## 입력 검사와 엣지 케이스

| 입력 | 처리 |
|---|---|
| 빈 입력, 텍스트만, 루트 2개 이상 | 에러 표시, Patch 취소 |
| 안 닫힌 태그, 짝이 안 맞는 태그, `>` 누락 | **줄 번호와 함께** 에러 |
| `<p>` 안의 `<div>`, `<tbody>` 없는 `<table>`, `</br>` | 브라우저가 구조를 몰래 고치므로 에러로 알림 |
| SVG 밖의 `<div/>` | HTML에선 `/`가 무시되어 열린 태그가 되므로 에러 |
| 변경 없이 Patch | patch 0개, 기록 추가 안 함 |
| 기록 처음/끝에서 뒤로/앞으로 | 버튼 비활성, 눌러도 그대로 |
| 뒤로 간 상태에서 Patch | 앞쪽 기록 잘라냄 (브라우저 방식) |
| `<b>a</b> <i>b</i>`, `&nbsp;` | 내용 공백으로 보존 (줄바꿈 섞인 들여쓰기만 제거) |
| `<svg>` | SVG 네임스페이스로 생성, `foreignObject` 안은 HTML |
| 실제 DOM이 patch 밖에서 바뀜 | 로그로 감지, patch 실패 시 전체 다시 그려 복구 |

## 알려진 한계 (다음 단계)

- **key 기반 diff 미지원**: 리스트 맨 앞을 지우면 REMOVE 1개가 아니라 TEXT/PROPS 여러 개 + 마지막 REMOVE로 나옵니다.
- **이벤트 미지원**: `onClick` 등은 지금은 건너뜁니다. (`src/props.js`의 `TODO(Phase 2)`)
- 루트 요소는 하나만 받습니다.
- `<textarea>`·`<script>` 안에 태그 모양 텍스트를 쓰면 구조 검사가 오탐할 수 있습니다.
- 뒤로/앞으로를 누르면 textarea에서 Patch하지 않은 편집 내용은 덮어씁니다.
- MutationObserver는 property 변경(`input.checked = true`)을 감지하지 못합니다.
