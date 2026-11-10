# Mini React — Virtual DOM부터 Hooks까지

외부 라이브러리 없이 React의 핵심 원리를 직접 구현한 프로젝트입니다. (크래프톤 정글 11~12주차)

- **Phase 1 · Virtual DOM**: VNode, diff/patch 5가지 케이스, 바뀐 부분만 실제 DOM에 반영하는 과정을 검증 페이지로 확인
- **Phase 2 · 컴포넌트와 Hooks**: 이벤트, 함수 컴포넌트, `useState` · `useEffect` · `useMemo`, Batching, 그리고 이것만으로 만든 할 일 앱
- **새 코어 (`src/core`) 1·2단계**: 같은 내용을 새 구조로 다시 만들고, 그 위에 **미니 대시보드**를 올림 (아래 "2단계" 참고)

## 실행 방법

**필요 환경**: Node.js `^22.13.0 || ^24.0.0 || >=26.0.0` (jsdom 29와 Vitest 5가 함께 지원하는 범위, 23·25는 제외), Python 3 (`npm run serve`용)

```bash
npm install        # 테스트 도구(jsdom, vitest) 설치
npm test           # 전체: 새 코어 node:test(109개) + 기존 vitest(282개)
npm run test:core  # 새 코어만 (node --test, tests/)
npm run test:watch # 기존 vitest를 파일 저장 시마다

npm run serve      # http://localhost:8000/          ← 새 페이지 (탭: Phase 1 검증 / 대시보드)
                   # http://localhost:8000/phase1/ (이전 Phase 1 검증 페이지)
                   # http://localhost:8000/phase2/ (Phase 2 할 일 앱 + 디버그 패널)
                   # http://localhost:8000/phase2-learn/ (Phase 2 개념 학습: 엔진을 한 단계씩 재생)
```

> ES 모듈(`import`)은 `file://`로 열면 브라우저가 막습니다. 반드시 HTTP 서버로 여세요.
> `npm run serve`는 `127.0.0.1`에만 열립니다. 모든 네트워크에 열면 같은 네트워크의 누구나 `/.git/` 같은 저장소 파일을 받아 갈 수 있습니다.
> `npx serve`로 열어도 됩니다.

## 새 코어 (src/core) — 다음 단계(Component·Hooks·대시보드)의 기반

```
index.html              # 상단 탭: [Phase 1 검증] / [대시보드]
src/core/
  vdom.js               # h(), createElement(VNode → DOM), domToVNode(DOM → VNode)
  diff.js               # diff(old, new) → patch 목록 (CREATE·REMOVE·REPLACE·UPDATE_PROPS·UPDATE_TEXT·MOVE)
  patch.js              # applyPatches(container, patches) → { created, removed, replaced, propsUpdated, textUpdated, moved }
  props.js              # 속성·class·style·value·checked·이벤트 핸들러 반영 (vdom·patch가 같이 씀)
src/phase1/             # 검증 페이지: main.js · history.js(뒤로/앞으로) · html.js(textarea ↔ VNode) · style.css
tests/                  # node:test + jsdom: vdom · diff · patch · history (+ 2단계 테스트)
```

- VNode: `{ type, key, props, children }`, 텍스트는 문자열. key는 props에서 빼서 따로 두고 DOM에 그리지 않는다.
- HTML에서는 `data-key="a"`가 key가 된다 (`domToVNode`가 읽음). 줄바꿈 섞인 공백 텍스트와 주석은 버린다.
- patch의 경로는 모두 **이전 트리 기준**이고, `applyPatches`는 DOM을 바꾸기 전에 모든 경로를 노드 참조로 먼저 찾아 둔다.
- key 리스트는 **최장 증가 부분 수열(LIS)** 로 "그대로 둘 수 있는 항목"을 최대한 남기고 나머지만 MOVE한다
  (맨 뒤 항목을 맨 앞으로 → MOVE 1개).
- 기존 `src/*.js`(Phase 1·2 코어), `phase1/`, `phase2/`, `phase2-learn/`, `test/`는 그대로 두었다. 다음 단계에서 새 코어로 옮기며 정리한다.

## 2단계 — Component · Hooks · 미니 대시보드 (src/core + src/app)

`src/core`의 `h` · `createElement` · `diff` · `applyPatches`를 **한 줄도 고치지 않고** 그 위에 함수형 컴포넌트와 Hooks를 올렸습니다.
그 위에 대시보드를 만들어, 데이터가 바뀌면 **바뀐 부분만** 실제 DOM에 반영되는 것을 깜빡임과 숫자로 보여 줍니다.

**실행**: `npm run serve` → http://127.0.0.1:8000/ → **[대시보드]** 탭

### 폴더 구조

```
src/core/
  component.js    # expand(): 컴포넌트 → 태그만 남은 VNode / FunctionComponent: mount · update · unmount
  hooks.js        # useState · useEffect · useMemo, Hook 규칙 검사(자식에서 호출, 순서 변경, 렌더 중 setState)
  scheduler.js    # setState 배칭: queueMicrotask로 모아서 update 1번
src/app/
  App.js          # 루트 컴포넌트 (Hook은 여기만), selectOrders · summarizeCategories
  components/     # Header · StatCard · FilterBar · OrderTable · MiniChart · CategoryStats · ControlPanel · RenderStats (모두 props만 받는 순수 함수)
  main.js         # 대시보드 탭에 mount, MutationObserver, RenderStats·비교 모드·배칭 토글 연결
  format.js · style.css
src/utils/
  fakeData.js     # 시드 기반 가짜 데이터 (방문자 · 매출 · 주문 · 차트), 불변 업데이트
  domStats.js     # MutationObserver 기록 요약(자식 포함 노드 수), 깜빡임 (Phase 1 페이지와 공유)
tests/            # hooks · component · scheduler · dashboard · domStats (+ 1단계 vdom · diff · patch · history)
```

### 동작 흐름

```
 [클릭]  "방문자 수만 변경"
   │  props.js가 붙여 둔 리스너 → handlers.onVisitors()
   ▼
 setData(d => changeVisitors(d))                     hooks.js
   │  ① 사물함(hooks[0]) 값 교체   — Object.is로 같으면 여기서 끝 (렌더 생략)
   │  ② component.requestUpdate()  — "다시 그려 줘" 예약
   ▼
 scheduleUpdate(component)                           scheduler.js
   │  Set에 넣고 queueMicrotask(flush) 1번만 예약    ← 같은 클릭의 setState 3번도 여기서 하나로
   ▼  (지금 실행 중인 클릭 핸들러가 끝난 직후)
 component.update()                                  component.js
   │  hookIndex = 0 → App() 다시 실행 → useState는 저장된 값, useMemo는 deps가 같으면 저장된 값
   │  expand(): Header · StatCard … 실행 → 태그만 남은 새 VNode
   │  diff(이전 VNode, 새 VNode) → patch 3개           diff.js
   │  applyPatches(container, patches, onApply=깜빡임) patch.js
   │  onRender → RenderStats 갱신 (patch 수 · 종류별 · MutationObserver · 소요 시간)
   ▼
 runEffects()                                        component.js
      deps가 바뀐 effect만: 옛 cleanup 먼저 → 새 effect (document.title, setInterval, body 클래스)
```

### 대시보드 구성

| 컴포넌트 | 받는 props | 바뀌는 때 |
|---|---|---|
| `App` (루트) | — | state 7개: `data` · `category` · `period` · `sort` · `darkMode` · `autoRefresh` · `refreshMs` |
| `Header` | 다크모드 · 자동 새로고침 · 주기, 각 핸들러 | 토글할 때 |
| `StatCard` × 3 | `label` · `value` · `prevValue` · `format` | 그 숫자가 바뀔 때만 |
| `FilterBar` | 카테고리 · 기간 · 정렬, 핸들러 | 필터를 바꿀 때 |
| `OrderTable` | 필터·정렬된 주문(`useMemo`) | 행 key = 주문 ID → 새 주문은 CREATE 1개, 정렬은 MOVE |
| `MiniChart` | 최근 매출 12건 | 막대 key = 점 id → 한 칸 밀릴 때 REMOVE 1 + CREATE 1 |
| `CategoryStats` | 카테고리별 합계·평균(`useMemo`) | 주문이 바뀔 때 |
| `ControlPanel` | 특정 데이터만 바꾸는 핸들러 | 바뀌지 않음 (핸들러를 `useMemo([])`로 한 번만 만듦) |
| `RenderStats` | 렌더 정보 · MutationObserver 요약 · 비교 평균 | App 밖에서 렌더마다 따로 그림 |

**Hook 활용**
- `useState`: 위 7개 state
- `useEffect`:
  - `[autoRefresh, refreshMs]`: 자동 새로고침 `setInterval`. 정지하거나 주기를 바꾸면 cleanup이 먼저 `clearInterval`
  - `[data.visitors]`: `document.title`
  - `[darkMode]`: body 클래스 `theme-dark` / `theme-light`
- `useMemo`:
  - 필터·정렬된 주문 목록 (`[data.orders, category, period, sort]`)
  - 카테고리별 합계·평균 (`[data.orders]`)
  - 핸들러 묶음 (`[]`)

**차별화 기능 (RenderStats 카드)**
- **변경 하이라이트**: `applyPatches`의 `onApply`로 바뀐 노드만 노란 테두리. "방문자 수만 변경"을 누르면 방문자 카드의 숫자와 증감만 깜빡입니다.
- **비교 모드** `Diff 사용 / 전체 다시 그리기`: 모드별 update의 평균 DOM 변경 수와 렌더 시간을 나란히 보여 줍니다.
- **배칭 토글**: "setState 3번" 버튼을 눌렀을 때 "이번 동작의 렌더"가 켜면 1번, 끄면 3번으로 나옵니다.

**브라우저에서 측정한 값** (헤드리스 Chrome, 시드 데이터 기준)

| 동작 | patch | 바뀐 DOM 노드 (자식 포함) |
|---|---|---|
| 방문자 수만 변경 | 3 (숫자 글자 · 증감 글자 · 증감 class) | 3 |
| 주문 1건 추가 | 13 (행 CREATE · 막대 CREATE/REMOVE · 카드 숫자 · 카테고리 표) | 24 |
| 카테고리 하나만 변경 | 7 (배지 글자 1 + 카테고리별 표 숫자 6) | 7 |
| 같은 "방문자 수만 변경"을 전체 다시 그리기로 | — (diff 안 함) | 약 630 (화면 전체를 지우고 새로 만듦) |

> 렌더 시간은 이 정도 크기의 화면에서는 두 모드 모두 1~2ms로 비슷합니다(전체 다시 그리기가 오히려 조금 빠를 때도 있음).
> diff 계산 자체에도 비용이 들기 때문입니다. 전체 다시 그리기의 비용은 이 숫자 밖에 있습니다.
> 노드 630개를 버리고 새로 만들어서 레이아웃을 다시 계산하고, 입력 포커스·선택 상태·스크롤도 잃습니다.
> 전체 다시 그리기 모드에서 select를 바꾸면 포커스가 사라지는 것으로 바로 확인할 수 있습니다.
> 화면이 커질수록 "바뀐 노드 수" 차이가 시간 차이로 이어집니다.

### 기능 테스트 체크리스트 (수동 확인)

`npm run serve` → http://127.0.0.1:8000/ → [대시보드]

- [ ] **방문자 수만 변경** → 방문자 카드의 숫자·증감만 깜빡이고, 탭 제목(`document.title`)의 방문자 수가 바뀐다. RenderStats patch 3
- [ ] **주문 1건 추가** → 표 맨 위에 행 1개(CREATE), 매출·주문 수 카드, 차트 막대(맨 앞 삭제 + 맨 뒤 추가), 카테고리 표가 깜빡인다
- [ ] 주문을 계속 추가 → 표는 **최대 12건**을 유지한다 (가장 오래된 행이 REMOVE)
- [ ] **카테고리 하나만 변경** → 맨 위 행의 배지 글자와 카테고리별 표의 숫자만 깜빡인다
- [ ] 정렬을 **금액 높은순**으로 → 행이 MOVE로 자리만 바뀌고 CREATE·REMOVE는 0
- [ ] 카테고리 **전자기기** (처음 데이터에 없음) → "조건에 맞는 주문이 없습니다." 다시 **전체** → 행이 돌아온다
- [ ] **setState 3번** → "이번 동작의 렌더 1번 / 묶인 setState 3번". **배칭** 체크를 끄고 다시 → "3번"
- [ ] **전체 다시 그리기**로 바꾸고 같은 버튼 → 화면 전체가 깜빡이고, 비교 카드의 "전체 다시 그리기" 평균 DOM 수가 수백 개
- [ ] **▶ 자동 새로고침** (주기 1초) → 1초마다 렌더. **■ 정지** → 렌더가 멈춘다. 다시 시작해도 1초에 1번 (interval 중복 없음)
- [ ] 자동 새로고침 중 **카테고리 필터 변경** → 새로 들어오는 주문에도 필터가 적용되고, 주기는 그대로
- [ ] 자동 새로고침 중 **주기 변경**(1초 → 5초) → 새 주기로 바뀐다 (옛 interval은 cleanup으로 정리)
- [ ] **다크/라이트** 여러 번 → 마지막 상태대로 페이지 전체 색이 바뀐다 (body 클래스)
- [ ] 개발자 도구 콘솔에 에러가 없다

자동 테스트(`npm test`)는 위 시나리오 대부분을 jsdom으로 다시 확인합니다. `tests/dashboard.test.js`가 그 예입니다.
가짜 타이머로 "살아 있는 interval 수"까지 셉니다.

### 발표용 설명

#### ① "함수는 매번 새로 실행되는데 상태는 어떻게 유지되나?"
- `App()`은 렌더마다 처음부터 다시 실행되므로 지역 변수는 매번 새로 생깁니다. 그래서 상태는 함수 **밖**, `FunctionComponent` 인스턴스의 `hooks` 배열(사물함)에 둡니다.
- 사물함에는 이름표가 없습니다. **호출 순서(`hookIndex`)가 번호**입니다. 렌더 시작 때 `hookIndex = 0`으로 되돌리면, 같은 순서로 불린 Hook이 같은 칸을 다시 엽니다.
  - 그래서 Hook은 if·for 안에서 부르면 안 됩니다. 순서가 바뀌면 이 구현은 `"2번째 Hook이 이전 렌더에서는 useState였는데…"` 에러를 냅니다.
- `setState`는 첫 렌더에 한 번 만들어 사물함에 넣어 둡니다. 이 함수는 **클로저**로 자기 칸(`slot`)과 컴포넌트를 기억합니다. 그래서 렌더가 끝난 뒤 클릭 핸들러에서 불려도 어디에 값을 넣고 누구를 다시 그릴지 압니다.

#### ② UI를 Component로 나눈 기준
- **화면에서 한 덩어리로 보이고, 한 가지 데이터로 그려지는 단위**로 나눴습니다. 카드 하나 = 숫자 하나, 표 = 주문 목록, 차트 = 매출 추이.
- **반복되는 모양**은 하나로 만들어 props만 바꿔 씁니다. `StatCard` × 3이 그 예입니다.
- **바뀌는 이유가 다른 것은 분리**했습니다. 필터(FilterBar)와 결과(OrderTable)를 나눠서, 각자 무엇이 바뀌면 다시 그려지는지 설명할 수 있게 했습니다.

#### ③ State를 루트에 둔 이유 (Lifting State Up)
- 필터를 바꾸면 표가 바뀌고, 주문이 들어오면 카드·표·차트·카테고리 표가 **함께** 바뀝니다. 여러 컴포넌트가 같은 데이터를 보므로 공통 조상(App) 한 곳에 둡니다.
- 데이터가 위에서 아래로만 흐르고(props), 바꾸는 요청은 아래에서 위로(핸들러) 올라갑니다. 그래서 "이 값은 누가 바꾸나?"의 답이 항상 App입니다.
- 자식은 props → VNode **순수 함수**라 같은 props면 같은 결과가 나오고, 렌더 밖에서 직접 불러 테스트할 수 있습니다.
  - 자식에서 Hook을 부르면 `"useState는 루트 컴포넌트(App)에서만 쓸 수 있습니다…"` 에러를 던집니다. 구현 방법: `hooks.js`가 지금 App을 실행 중인지(root), 자식을 펼치는 중인지(children)를 기록해 둡니다.

#### ④ setState가 상태 변경 외에 하는 일
1. **같은 값이면 아무것도 하지 않습니다** (`Object.is`). 렌더를 생략합니다.
2. **다시 그리기를 예약**합니다 (`requestUpdate` → `scheduleUpdate`). 바로 그리지 않습니다.
3. **함수형 업데이트** `setState(prev => next)`이면 사물함의 **최신 값**을 넘겨, 연속 호출이 모두 반영됩니다.
4. **잘못된 사용을 막습니다.** 렌더 중 setState는 무한 렌더가 되므로 에러를 냅니다. unmount 뒤의 setState는 무시합니다.

#### ⑤ 배칭 원리
- setState는 컴포넌트를 큐(`Set`)에 넣기만 하고, 큐를 비우는 `flush`는 **`queueMicrotask`** 로 미룹니다.
- 마이크로태스크는 "지금 실행 중인 코드(클릭 핸들러)가 **끝난 직후**, 브라우저가 화면을 그리기 **전**"에 실행됩니다. 그 시점에는 같은 핸들러의 setState가 모두 끝나 있습니다.
  - → setState 3번 = 큐에 1번(Set이라 중복 없음) = update 1번. 중간 상태(1, 2)는 화면에 나타나지 않습니다.
- 배칭을 끄면 setState마다 바로 update합니다. diff·patch·effect가 3번 돌고, 같은 화면을 세 번 그립니다.

#### ⑥ useEffect를 patch 뒤에 실행하는 이유
- 렌더 함수는 순수해야 하고 몇 번 실행될지 모릅니다. 그래서 타이머·`document.title`·body 클래스처럼 **바깥세상을 바꾸는 일**은 화면 반영이 끝난 뒤로 뺍니다.
- deps 비교 규칙:
  - 생략하면 매 렌더 실행합니다.
  - `[]`이면 처음 한 번만 실행합니다.
  - `[a]`이면 a가 바뀔 때만 실행합니다.
- 다시 실행하기 전에 **옛 cleanup을 먼저** 부릅니다. effect가 여러 개면 cleanup을 모두 먼저 부르고 나서 새 effect를 실행합니다(A정리 → B정리 → A → B).
  - 그래서 자동 새로고침을 껐다 켜도 interval이 하나만 남습니다.

#### ⑦ 이번 구현과 실제 React의 차이

| 주제 | 이번 구현 | React |
|---|---|---|
| 렌더 단위 | 루트 하나를 통째로 다시 실행 → 전체 VNode diff | 컴포넌트마다 다시 그릴지 판단 (state가 바뀐 컴포넌트부터, `memo`로 건너뛰기) |
| 자료구조 | VNode 트리 두 개를 재귀로 비교 | **Fiber**: 컴포넌트마다 노드 하나(child·sibling·return 포인터). 작업을 쪼개 멈췄다 이어 갈 수 있음 |
| 재조정(Reconciliation) | diff로 patch 목록을 만든 뒤 한 번에 적용 | render 단계(무엇이 바뀌었나 계산, 중단 가능) → commit 단계(DOM 반영, 한 번에) |
| 자식 state | 금지 (Hook은 App에서만, 에러) | 모든 컴포넌트가 자기 state·Hook을 가짐 (Fiber마다 Hook 연결 리스트) |
| 이벤트 | 요소마다 `addEventListener` | **이벤트 위임**: 루트에 리스너 하나, 합성 이벤트(SyntheticEvent)로 브라우저 차이를 감춤 |
| 배칭 | `queueMicrotask`로 같은 틱을 묶음 | React 18+: 자동 배칭 + 우선순위(lane)별로 묶음 |
| 동시성 렌더링 | 없음. 렌더는 끝날 때까지 멈추지 않음 | `startTransition` 등으로 급한 업데이트(입력)를 먼저, 무거운 렌더는 양보하며 나눠서 |
| effect 시점 | patch 직후 동기 실행 | `useEffect`는 화면을 그린 뒤 비동기, `useLayoutEffect`는 그리기 전 |
| key 리스트 이동 | LIS로 최소 이동 (Vue 3 방식) | 앞에서부터 `lastPlacedIndex` 휴리스틱 (맨 뒤 → 맨 앞 이동 시 나머지가 모두 움직임) |

### 이 단계에서 쓰인 JS 문법

**클로저**: 함수가 만들어질 때 주변 변수를 기억합니다. Java의 익명 클래스가 바깥 final 변수를 잡는 것과 비슷하지만, JS는 그 변수를 계속 **읽고 쓸 수** 있습니다.
```js
// hooks.js — setState는 자기 slot과 component를 기억한다 (렌더가 끝나도)
slot.setState = (action) => {
  const nextValue = typeof action === 'function' ? action(slot.value) : action;
  if (Object.is(nextValue, slot.value)) return;
  slot.value = nextValue;
  component.requestUpdate();
};
// scheduler.js — 모듈 안의 변수(dirtyComponents)는 이 파일의 함수들만 볼 수 있다 (private static 필드처럼)
const dirtyComponents = new Set();
```

**setInterval / clearInterval**: n밀리초마다 함수를 부르고, 돌려받은 id로 멈춥니다.
```js
// App.js — effect가 interval을 열고, cleanup이 닫는다
useEffect(() => {
  if (!autoRefresh) return undefined;
  const id = timers.setInterval(() => setData((d) => tick(d, random, now())), refreshMs);
  return () => timers.clearInterval(id);   // 정지·주기 변경·unmount 때 불림
}, [autoRefresh, refreshMs]);
```

**queueMicrotask**: "지금 코드가 끝나면 바로" 실행합니다. `setTimeout(fn, 0)`(다음 매크로태스크)보다 먼저, 화면을 그리기 전에 실행됩니다.
```js
// scheduler.js
dirtyComponents.add(component);
if (isFlushScheduled) return;
isFlushScheduled = true;
queueMicrotask(flushUpdates);
```

**고차 함수**: 함수를 인자로 받거나 함수를 돌려주는 함수입니다.
```js
// App.js — createApp은 "App 함수"를 돌려준다 (의존성을 주입한 컴포넌트 공장)
export function createApp({ random, now, timers }) { return function App() { ... }; }
// 함수형 업데이트 — setState가 "다음 값을 만드는 함수"를 받는다
setData((d) => changeVisitors(d, random));
// map · filter · reduce — 배열을 받아 새 배열·값을 만든다 (원본은 그대로)
const total = items.reduce((sum, order) => sum + order.amount, 0);
orders.map((order) => h('tr', { key: order.id }, ...));
```

**그 밖에**
- `Object.is(a, b)`: `===`과 거의 같지만 `NaN`끼리도 같다고 봅니다. setState와 deps 비교에 씁니다.
- `{ ...data, visitors: 120 }`: 객체를 복사하면서 한 필드만 바꿉니다(불변 업데이트). 원본이 그대로라 `Object.is`로 "바뀌었다"를 알 수 있습니다.
- `try { … } finally { … }`: 렌더 중 에러가 나도 "렌더 중" 표시를 반드시 끕니다(`runRender`).
- `class` · `constructor` · `this`: Java와 거의 같습니다. `FunctionComponent`가 필드(hooks, hookIndex, vnode, container)와 메서드(mount, update)를 가집니다.

## 폴더 구조 (이전 코드)

```
ai-framework/
├── src/                    # 라이브러리 코어 (브라우저·테스트 공용, 외부 의존성 없음)
│   ├── vdom.js             # VNode 모양, h(), render() (SVG 네임스페이스 포함)
│   ├── props.js            # setProp / removeProp / updateProps — 속성·프로퍼티·이벤트 반영의 단일 창구
│   ├── diff.js             # diff(old, new) → patch 목록, patch(container, patches) → 실제 DOM 반영
│   ├── component.js        # expand() — 컴포넌트 펼치기, FunctionComponent — mount/update/unmount 렌더 루프
│   ├── hooks.js            # useState · useEffect · useMemo — hooks 배열 + 호출 순서로 상태 유지
│   ├── domToVNode.js       # 실제 DOM → VNode
│   ├── parseHTML.js        # HTML 문자열 → VNode (태그 짝·중첩 규칙 검사, 줄 번호 에러)
│   ├── toHTML.js           # VNode → 들여쓴 HTML 문자열
│   ├── htmlTags.js         # VOID_TAGS — parseHTML·toHTML이 공유하는 void 태그 목록
│   ├── history.js          # 뒤로/앞으로 기록 (배열 + 현재 인덱스)
│   └── mutationStats.js    # MutationRecord → 추가/삭제/속성/텍스트 변경 수
├── phase1/                 # Phase 1 검증 페이지 (HTML 편집 → Patch → 뒤로/앞으로, patch vs innerHTML 비교)
├── phase2/                 # Phase 2 할 일 앱 (우리 라이브러리만 사용)
│   ├── app.js              # App(Hook은 여기만) + 순수 자식 컴포넌트, sanitizeTodos
│   ├── main.js             # 마운트, localStorage, 디버그 패널(onRender + MutationObserver)
│   ├── index.html
│   └── style.css
├── phase2-learn/           # Phase 2 개념 학습 페이지 (실제 엔진 기록을 한 단계씩 재생)
│   ├── scenarios.js        # 4개 장: 예제 컴포넌트, 실험 조절, 실행 대본
│   ├── recorder.js         # trace 사건 + 그 순간의 스냅샷 → steps
│   ├── explain.js          # 사건 → 출처(파일 › 함수)·설명·강조할 코드 줄
│   ├── main.js             # 3단 화면, 이전/다음/처음부터, ← → 키
│   ├── index.html
│   └── style.css
└── test/                   # vitest + jsdom 단위 테스트 (282개)
```

### 계층

```
phase1/ · phase2/          화면 (이벤트 연결, 패널)
      │
component.js · hooks.js    Phase 2: 컴포넌트를 펼치고(expand), 상태가 바뀌면 다시 그림
      │
diff.js · vdom.js          Phase 1: 두 VNode를 비교하고(diff) 실제 DOM에 반영(patch, render)
      │
props.js                   속성 · 프로퍼티 · 이벤트 리스너
```

아래 계층은 위 계층을 모릅니다. Phase 2를 만들면서 diff/patch는 한 줄도 바꾸지 않았습니다.

---

## Phase 1 — Virtual DOM diff & patch

### 검증 페이지 데이터 흐름

```
[로드]   실제 영역 DOM ─toVNode→ v1 ─→ history [v1]
                                  └→ toHTML → textarea,  render → 미리보기
[입력]   textarea ─parseHTML→ VNode ─render→ 미리보기         (실제 영역은 그대로)
[Patch]  textarea ─parseHTML→ next
         diff(history.current(), next) → patches
         patch(실제 영역, patches)      ← MutationObserver가 변경 수를 셈
         history.push(next)
[뒤로]   diff(현재, history.back()) → patch → textarea·미리보기도 함께
```

### 1. 브라우저 렌더링과 Reflow · Repaint

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
// <li class="todo">빨래</li>
{ type: 'li', props: { class: 'todo' }, children: ['빨래'] }
```

1. 화면이 어떻게 생겨야 하는지를 VNode로 새로 만든다. (JS 객체라 만들고 버리기가 싸다)
2. 이전 VNode와 **diff** 해서 달라진 점만 patch 목록으로 뽑는다.
3. 그 목록만 실제 DOM에 **patch** 한다. (비싼 DOM 조작을 최소화)

### 3. Diff 5가지 케이스

`src/diff.js`는 두 트리를 같은 위치(path)끼리 재귀 비교합니다. path는 루트에서 자식 인덱스를 따라간 경로입니다.

| 케이스 | 조건 | 실제 DOM 조작 |
|---|---|---|
| **CREATE** | 이전엔 없고 새로 생김 | `insertBefore(render(vnode))` |
| **REMOVE** | 이전엔 있고 새엔 없음 | `node.remove()` |
| **REPLACE** | 태그 종류가 다름 (또는 텍스트 ↔ 요소) | `replaceWith(render(vnode))` |
| **TEXT** | 둘 다 텍스트인데 내용이 다름 | `nodeValue = 새 텍스트` |
| **PROPS** | 같은 태그인데 속성이 다름 | `updateProps` (추가·변경·삭제) |

```
자식 비교 (인덱스 기준)
공통 길이까지   → 같은 인덱스끼리 재귀 비교
새 쪽이 더 길면 → 뒤에 CREATE
옛 쪽이 더 길면 → 뒤에서부터 REMOVE (앞쪽 인덱스가 밀리지 않도록)
```

**attribute와 property**: `value`, `checked`, `selected`는 HTML 속성(초기값)과 DOM 프로퍼티(현재 화면 값)가
사용자 입력 이후 따로 움직입니다. `setProp`은 둘 다 맞추고, `key` prop은 DOM에 그리지 않습니다.

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

### Phase 1 엣지 케이스

| 입력 | 처리 |
|---|---|
| 빈 입력, 텍스트만, 루트 2개 이상 | 에러 표시, Patch 취소 |
| 안 닫힌 태그, 짝이 안 맞는 태그, `>` 누락 | **줄 번호와 함께** 에러 |
| `<p>` 안의 `<div>`, `<tbody>` 없는 `<table>`, `</br>` | 브라우저가 구조를 몰래 고치므로 에러로 알림 |
| SVG(또는 `foreignObject` 안) 밖의 `<div/>` | HTML에선 `/`가 무시되어 열린 태그가 되므로 에러 |
| 변경 없이 Patch | patch 0개, 기록 추가 안 함 |
| 기록 처음/끝에서 뒤로/앞으로, 뒤로 간 상태에서 Patch | 버튼 비활성 / 앞쪽 기록 잘라냄 (브라우저 방식) |
| `<b>a</b> <i>b</i>`, `&nbsp;` | 내용 공백으로 보존 (줄바꿈 섞인 들여쓰기만 제거) |
| `<svg>` | SVG 네임스페이스로 생성, `foreignObject` 안은 HTML |
| 실제 DOM이 patch 밖에서 바뀜 | 로그로 감지, patch 실패 시 전체 다시 그려 복구 |

---

## Phase 2 — 컴포넌트와 Hooks

### 한눈에 보기

```js
import { h } from './src/vdom.js';
import { FunctionComponent } from './src/component.js';
import { useState } from './src/hooks.js';

const Counter = ({ count, onIncrease }) =>          // 자식: props만 받는 순수 함수
  h('button', { onClick: onIncrease }, `클릭 ${count}`);

function App() {                                     // 루트: Hook은 여기만
  const [count, setCount] = useState(0);
  return h('main', null, h(Counter, { count, onIncrease: () => setCount((c) => c + 1) }));
}

new FunctionComponent(App, document.getElementById('app')).mount();
```

### 렌더 루프: setState부터 화면까지

```
클릭 ─→ 리스너(props.js) ─→ setState(c => c + 1)
                              ├ 사물함 값 갱신 (같은 값이면 여기서 끝)
                              └ scheduleUpdate()  ── 이미 예약됐으면 건너뜀 (Batching)
                                    │ queueMicrotask
                                    ▼
update()
 ├ hookIndex = 0 → App() 다시 실행     useState는 사물함에서 최신 값을 꺼냄, useMemo는 deps가 같으면 재사용
 ├ expand()                            컴포넌트를 끝까지 실행해 태그만 남은 VDOM으로
 ├ diff(prevVNode, next)               ← Phase 1 엔진
 ├ patch(container, patches)           ← Phase 1 엔진 (바뀐 곳만 실제 DOM 수정)
 ├ prevVNode = next, onRender(...)
 └ runEffects()                        옛 cleanup 전부 → 새 effect (deps가 바뀐 것만)
```

Phase 1에서는 사람이 textarea로 다음 VNode를 만들었고, Phase 2에서는 **컴포넌트 함수가** 만듭니다.
그 뒤 `diff → patch`는 같습니다.

### 1. 이벤트

`onClick`처럼 `on` + 대문자로 시작하는 **함수** prop은 `addEventListener`로 붙습니다.
(`onClick` → `click`, `onInput` → `input`, `onDoubleClick` → `dblclick`)

- 핸들러가 바뀌면 **옛 핸들러를 떼고** 새 핸들러를 붙입니다. 떼지 않으면 클릭 한 번에 둘 다 실행됩니다.
- 렌더마다 새로 만든 함수는 **최신 상태를 담은 클로저**라 PROPS로 잡아 교체합니다(stale closure 방지).
  같은 함수 참조를 넘기면 patch가 나오지 않습니다.
- HTML에서 온 문자열 핸들러(`onclick="..."`)는 코드로 실행되지 않도록 무시합니다.

### 2. 컴포넌트와 expand

```
h(App)  →  { type: App ƒ }                 h()는 기록만 (아직 실행 안 함)
expand  →  App() → Card ƒ → TodoList ƒ → TodoItem ƒ ...   함수 type을 재귀로 실행
        →  main > section > ul > li ...    태그만 남은 Phase 1 VDOM
```

- 태그 안에 쓴 자식은 `props.children`(배열)으로 받습니다.
- `null`·`false`를 돌려주면 그 자리가 비고, `undefined`(return 누락)·배열은 원인을 알려 주는 에러를 냅니다.

### 3. useState와 hooks 배열 (사물함)

컴포넌트 함수는 렌더마다 새로 실행되므로 지역 변수로는 상태를 기억할 수 없습니다.
그래서 상태는 함수 밖, `FunctionComponent` 인스턴스의 `hooks` 배열에 **호출 순서대로** 둡니다.

```
hooks = [ {useState: 3}, {useMemo: …, deps}, {useEffect: deps, cleanup} ]
           ↑ 0번          ↑ 1번               ↑ 2번       렌더마다 hookIndex = 0부터 다시 연다
```

- `useState(초기값)`: 첫 렌더에만 초기값을 씁니다. `useState(() => 계산)`이면 그 함수를 첫 렌더에 한 번만 실행합니다.
- `setState(값 | prev => 새값)`: 같은 값(`Object.is`)이면 다시 그리지 않습니다. setState는 첫 렌더에 한 번 만들어 렌더마다 같은 함수입니다.
- **클로저**: setState는 자기 사물함과 컴포넌트를 기억해 렌더가 끝난 뒤에도 동작합니다.
  `setCount(count + 1)`은 렌더 시점의 `count`를, `setCount(c => c + 1)`은 사물함의 최신 값을 씁니다.

#### Hook 규칙 (어기면 원인을 알려 주는 에러)

| 규칙 | 이유 | 어기면 |
|---|---|---|
| 루트 컴포넌트에서만 | 사물함(`hooks` 배열)이 루트 인스턴스 하나뿐 | "루트 컴포넌트에서만 쓸 수 있습니다" |
| 렌더 중에만 (핸들러·setTimeout 안 X) | 어느 컴포넌트의 사물함인지 알 수 없음 | "렌더되는 중에만 호출할 수 있습니다" |
| if·for 안 X, 항상 같은 순서·개수 | 사물함은 번호로만 찾음 | "n번째 Hook이 이전 렌더에서는 useState였는데…", "Hook 개수가 이전 렌더(3개)와 다릅니다" |
| 렌더 중 setState X | 렌더 → setState → 렌더… 무한 반복 | "렌더 중에 setState를 호출하면…" |

### 4. Batching

같은 틱에서 setState를 여러 번 불러도 **렌더는 한 번**입니다. `queueMicrotask`로 예약만 하고, 이미 예약돼 있으면 다시 예약하지 않습니다.

| 클릭 한 번에 setState 3번 | 렌더 | 실제 DOM 텍스트 변경 | 중간값(1, 2) |
|---|---|---|---|
| Batching 켬 (기본) | **1번** | **1번** | 화면에 안 나옴 |
| `{ batching: false }` | 3번 | 3번 | DOM을 거쳐 감 |

`renderCount`, `lastBatchSize`를 기록하고, `onRender(info)`로 렌더마다 `{ type, renderCount, batchSize, patches }`를 받습니다.
렌더 횟수를 useState에 넣으면 무한 렌더가 되므로 화면 밖(디버그 패널)에서 표시합니다.

### 5. useEffect와 생명주기

| deps | 실행 |
|---|---|
| 없음 | 매 렌더 |
| `[]` | 처음 한 번 (클래스의 `componentDidMount`) |
| `[a, b]` | 원소 하나라도 바뀌면, `Object.is` 얕은 비교 (`componentDidUpdate` + 조건) |
| 반환한 cleanup | 다시 실행 직전 + `unmount()` 때 (`componentWillUnmount`) |

- 렌더 중에는 실행 여부만 판단해 예약하고, **patch가 끝난 뒤** 실행합니다(React `useLayoutEffect`와 같은 시점).
- 다시 실행할 때는 **옛 cleanup을 모두 먼저**, 그다음 새 effect들을 실행합니다.
- `unmount()` 뒤의 setState·예약된 update는 무시합니다.

### 6. useMemo

렌더 **도중** 바로 계산해 값을 돌려주고, deps가 같으면(useEffect와 같은 `haveDepsChanged`) 저장된 값을 재사용합니다.

| | useMemo | useEffect |
|---|---|---|
| 언제 | 렌더 도중 (동기) | patch가 끝난 뒤 |
| 결과 | 그 렌더의 화면을 만드는 데 사용 | 없음 (cleanup 함수만) |
| 용도 | 순수한 계산 재사용 (최적화) | DOM·타이머·요청 등 바깥세상 일 (기능) |

### 7. Lifting State Up — 할 일 앱의 구조

```
App  ← useState(todos, input, filter) · useMemo(목록·개수·핸들러) · useEffect(title·localStorage)
 ├ TodoInput  { value, onInput, onSubmit }
 ├ FilterBar  { filter, counts, onSelect }
 ├ TodoList   { todos, emptyMessage, onToggle, onDelete }
 │   └ TodoItem { todo, onToggle, onDelete }
 └ TodoFooter { remaining, doneCount, onClearDone }

데이터는 아래로 ↓ (props)    변경은 위로 ↑ (App이 내려준 핸들러 → setState)
```

- 상태가 한 곳에만 있어 형제(TodoInput ↔ TodoList)가 같은 데이터를 보고, 화면끼리 값이 어긋나지 않습니다.
- 핸들러는 `useMemo([])`로 한 번만 만들고 항목 id는 `data-id`로 전달합니다. 렌더마다 새 핸들러를 만들면
  글자 하나 칠 때마다 모든 항목에 PROPS patch가 생기기 때문입니다. (입력 한 글자 → patch 1개)

#### 브라우저에서 측정한 patch 수 (샘플 3개 기준)

| 동작 | patch | 바뀐 DOM 노드 |
|---|---|---|
| 입력 한 글자 | **1** (input value) | 1 |
| 항목 추가 | 6 (CREATE li + 개수 3 + 입력창 2) | 12 |
| 완료 체크 | **5** (그 항목 class·checked + 개수 3) | 5 |
| **마지막** 항목 삭제 | **4** (REMOVE + 개수 3) | 10 |
| **첫** 항목 삭제 | 11 ⚠️ 인덱스 diff라 뒤 항목들이 "바뀐 것"으로 보임 | 21 |

### Phase 2 엣지 케이스

| 경우 | 처리 |
|---|---|
| Hook 개수·순서가 렌더마다 달라짐 (if 안의 Hook) | 몇 번째 Hook이 어떻게 달라졌는지 알려 주는 에러 |
| deps 없는 useEffect 안에서 setState (무한 렌더) | 한 틱에 예약 렌더가 50번 넘게 이어지면 멈추고 원인을 알림 |
| `useState(() => 계산)` | 지연 초기화: 첫 렌더에 한 번만 실행 |
| 이미 mount된 컴포넌트를 다시 `mount()` | 에러 (`unmount()` 후 다시 mount는 가능) |
| 같은 틱에 체크 2번 / 같은 삭제 버튼 2번 | 원래대로 돌아옴(렌더 1번) / 하나만 삭제 |
| 빈 목록, 마지막 항목 삭제 | 필터별 안내 문구, 버튼 비활성, `ul → p` REPLACE |
| localStorage에 깨진 데이터 | `sanitizeTodos`가 올바른 항목만 남기고 빠진 값은 채움 (배열이 아니면 샘플로 시작) |
| unmount 뒤 늦게 온 setState (타이머 등) | 무시 |
| 예약된 update가 있는 채로 unmount → 같은 인스턴스를 다시 mount | 세대 번호(`mountGeneration`)가 달라 옛 예약·옛 setState는 새 트리에 적용되지 않음 |
| update 중 렌더 에러 | 콘솔에 에러, 화면은 이전 상태 유지, 다음 setState는 정상 |

---

## React와 비교

| 항목 | React | 우리 구현 |
|---|---|---|
| **렌더 작업 단위 (Fiber)** | 트리를 Fiber 노드 연결 리스트로 바꿔 작업을 잘게 쪼갬. 중간에 멈췄다 이어 하고, 급한 업데이트(입력)를 먼저 처리 (동시성 렌더) | 재귀로 트리 전체를 한 번에 끝까지 처리. 중간에 멈출 수 없음 |
| **render / commit 단계** | render(비교, 중단 가능) → commit(DOM 반영, 한 번에) | `diff`(patch 목록 만들기) → `patch`(한 번에 반영). 구조는 같고 중단만 없음 |
| **state 위치** | 컴포넌트마다 자기 Fiber에 Hook 목록이 붙음. 어느 컴포넌트든 Hook 사용 | 루트 인스턴스 하나의 `hooks` 배열. 자식 컴포넌트는 Hook 금지 (Lifting State Up) |
| **다시 그리는 범위** | setState한 컴포넌트와 그 아래만. `memo`로 건너뛰기 가능 | 항상 루트부터 전체 트리를 다시 실행·diff |
| **컴포넌트 경계** | diff할 때도 컴포넌트 타입을 비교. 타입이 같으면 state 유지 | `expand`로 펼친 뒤 태그만 비교. diff 시점엔 컴포넌트가 사라짐 |
| **리스트 비교 (key)** | `key`로 같은 항목을 찾아 이동·재사용 | 인덱스 기준. 앞쪽을 지우면 뒤 항목이 모두 TEXT·PROPS로 바뀜 (`key`는 그리지 않고 남겨만 둠) |
| **이벤트 (Synthetic Event)** | 루트 한 곳에 리스너를 두고 위임. 브라우저 차이를 맞춘 SyntheticEvent. `onChange`는 입력마다 발생 | 요소마다 `addEventListener`. 네이티브 이벤트 그대로. `onChange`는 진짜 `change`(포커스 잃을 때 등) |
| **Batching** | React 18부터 이벤트·타이머·Promise 어디서든 자동 배칭. `flushSync`로 즉시 반영 | 마이크로태스크로 같은 틱의 setState를 묶음. `{ batching: false }`는 비교용 |
| **setState 적용** | 업데이트를 큐에 쌓았다가 렌더할 때 계산 | 사물함 값을 즉시 바꾸고 렌더만 예약 |
| **useEffect 시점** | 브라우저가 화면을 그린 뒤 비동기 실행. 동기는 `useLayoutEffect` | patch 직후 동기 실행 (`useLayoutEffect`에 가까움) |
| **Hook 규칙 검사** | 개발 모드 경고 + ESLint 플러그인(`rules-of-hooks`) | 실행 중 Hook 개수·종류를 비교해 에러 |
| **무한 업데이트 방지** | "Maximum update depth exceeded" | 한 틱에 예약 렌더 50번 초과 시 에러 |
| **에러 처리** | Error Boundary로 하위 트리만 대체 화면 | 없음. 콘솔 에러, 이전 화면 유지 |
| **JSX · 속성 이름** | JSX → `createElement`. `className`, `htmlFor`, `style` 객체 | `h()` 직접 호출. HTML 이름 그대로(`class`, `for`), `style`은 문자열 |
| **그 밖** | Fragment, Context, Portal, Suspense, Server Components, StrictMode | 없음 |

**같은 점**: 선언적 UI(`화면 = f(상태)`), VDOM diff/patch, 호출 순서 기반 Hooks, 함수형 업데이트, deps 얕은 비교, cleanup 순서, Batching.

## 알려진 한계 (다음 단계)

- **key 기반 diff 미지원**: 리스트 앞·중간이 바뀌면 patch가 많아집니다. (할 일 앱에서 첫 항목 삭제 시 11개, 이상적으로는 4개)
- Hook은 루트 컴포넌트에서만 쓸 수 있습니다. (컴포넌트별 state 없음)
- 컴포넌트는 배열(Fragment)을 돌려줄 수 없고, 루트 요소는 하나만 받습니다.
- Error Boundary가 없습니다.
- 한글 입력(IME) 조합 중 동작은 헤드리스 브라우저로 확인하지 못했습니다.
- `<textarea>`·`<script>` 안에 태그 모양 텍스트를 쓰면 Phase 1 구조 검사가 오탐할 수 있습니다.
- MutationObserver는 property 변경(`input.checked = true`)을 감지하지 못합니다.
