// 핵심 코드 해설 데이터 + 렌더링 (일반 스크립트: 파일을 더블클릭해서 열어도 동작)
// 코드 조각은 src/lib/ 의 실제 코드에서 주석만 줄여 옮긴 것이다.
(function () {
  'use strict';
  // IntersectionObserver 가 없는 환경에서도 나머지 기능은 동작하도록
  function NoopObserver() { return { observe() {}, disconnect() {} }; }

  const SECTIONS = [
    {
      id: 'h',
      group: 'Phase 1 · Virtual DOM',
      title: 'h() — Virtual DOM 노드 만들기',
      file: 'src/lib/vdom.js',
      summary: 'JSX 가 변환되면 나오는 React.createElement 와 같은 함수입니다. 화면 설계도 한 조각(VNode)을 객체로 만듭니다.',
      chunks: [
        {
          code: `export function h(type, props, ...children) {
  const p = props ? { ...props } : {};
  const key = p.key ?? null;
  delete p.key;`,
          note: 'props 를 복사해서 쓰므로 호출한 쪽의 객체를 바꾸지 않습니다. key 는 DOM 속성이 아니라 "리스트에서 같은 항목을 알아보는 이름표" 라서 props 에서 빼내 따로 보관합니다.',
        },
        {
          code: `  for (const c of children) if (Array.isArray(c)) checkListKeys(c, type);
  return { type, props: p, key, children: normalizeChildren(children) };
}`,
          note: 'map 으로 만든 배열 자식에 key 가 빠졌으면 개발 경고를 냅니다. 마지막으로 { type, props, key, children } 객체를 돌려줍니다. 이게 VNode 의 전부입니다.',
        },
        {
          code: `export function normalizeChildren(children, out = []) {
  for (const c of children) {
    if (Array.isArray(c)) normalizeChildren(c, out);          // 중첩 배열은 평탄화
    else if (c == null || typeof c === 'boolean') continue;   // null, false 는 무시
    else if (typeof c === 'object') out.push(c);              // 이미 VNode
    else out.push(createText(c));                             // 문자열·숫자 → 텍스트 노드
  }
  return out;
}`,
          note: '자식을 정리합니다. false 와 null 을 건너뛰기 때문에 cond && h(...) 같은 조건부 렌더링이 됩니다. 문자열은 type 이 "#text" 인 텍스트 VNode 로 바뀝니다.',
        },
      ],
      explain: {
        q: 'Virtual DOM 은 실제로 어떻게 생겼나요?',
        a: 'type, props, key, children 네 가지를 가진 평범한 자바스크립트 객체입니다. h() 가 이 객체를 만들고, 자식 중 문자열은 텍스트 노드 객체로 바꾸고 null/false 는 빼서 조건부 렌더링을 지원합니다.',
      },
    },
    {
      id: 'dom2v',
      group: 'Phase 1 · Virtual DOM',
      title: 'domToVNode() — 실제 DOM 을 읽어서 VNode 로',
      file: 'src/lib/vdom.js',
      summary: 'Phase 1 에서 "실제 영역" 의 HTML 을 Virtual DOM 으로 바꾸는 함수입니다.',
      chunks: [
        {
          code: `if (node.nodeType === 3 /* TEXT_NODE */) {
  const text = node.nodeValue;
  if (isFormattingWhitespace(text)) return null;
  return createText(text);
}
if (node.nodeType !== 1 /* ELEMENT_NODE */) return null;`,
          note: '텍스트 노드면 텍스트 VNode 로. 단, 줄바꿈이 들어간 공백만 있는 텍스트(HTML 들여쓰기)는 버립니다. 그래야 코드 정렬을 바꿔도 diff 가 "바뀌었다" 고 하지 않습니다. 주석 등 나머지 노드도 버립니다.',
        },
        {
          code: `const props = {};
for (const attr of node.attributes) {
  if (sanitize && /^on/i.test(attr.name)) continue;  // onclick 같은 인라인 스크립트 제거
  props[attr.name] = attr.value;
}
const key = props.key ?? props['data-key'] ?? null;`,
          note: '속성을 props 로 옮깁니다. 사용자가 입력한 HTML 의 onclick 같은 속성은 보안을 위해 뺍니다. key 나 data-key 속성이 있으면 리스트 비교에 쓸 key 로 삼습니다.',
        },
        {
          code: `const children = [];
for (const child of source.childNodes) {
  const v = domToVNode(child, options);
  if (v) children.push(v);
}
return { type, props, key, children };`,
          note: '자식들도 같은 함수로 재귀 변환합니다. 결국 DOM 트리 전체가 같은 모양의 객체 트리가 됩니다.',
        },
      ],
      explain: {
        q: 'DOM 을 Virtual DOM 으로 바꿀 때 주의한 점은?',
        a: '들여쓰기 공백과 주석은 버려서 코드 정렬이 diff 결과에 영향을 주지 않게 했고, script 태그와 on 으로 시작하는 속성은 제거해서 사용자가 입력한 HTML 이 스크립트를 실행하지 못하게 했습니다.',
      },
    },
    {
      id: 'diff',
      group: 'Phase 1 · Diff',
      title: 'diff() — 노드 하나 비교하기',
      file: 'src/lib/diff.js',
      summary: '이전 노드와 새 노드를 비교해서 patch(변경 지시서)를 쌓습니다. 5가지 케이스가 모두 여기서 갈립니다.',
      chunks: [
        {
          code: `export function diff(oldVNode, newVNode, path = [], patches = []) {
  if (oldVNode === newVNode) return patches;`,
          note: '같은 객체면 그 아래도 전부 같습니다 (VNode 는 불변). 비교를 통째로 건너뜁니다. useMemo 로 VNode 를 재사용하면 이 줄 덕분에 빨라집니다. path 는 루트에서 이 노드까지의 childNodes 번호들입니다.',
        },
        {
          code: `  if (oldVNode == null || newVNode == null || !isSameNode(oldVNode, newVNode)) {
    patches.push({ type: 'REPLACE', path, node: newVNode ?? null, oldNode: oldVNode ?? null });
    return patches;
  }`,
          note: '③ REPLACE: 타입(태그)이나 key 가 다르면 "다른 노드" 로 보고 통째로 교체합니다. 하위는 비교하지 않고 return. 이 가정 덕분에 O(n³) 비교를 피합니다.',
        },
        {
          code: `  if (newVNode.type === TEXT) {
    if (oldVNode.text !== newVNode.text) {
      patches.push({ type: 'TEXT', path, text: newVNode.text, oldText: oldVNode.text });
    }
    return patches;
  }`,
          note: '④ TEXT: 둘 다 텍스트 노드인데 글자가 다르면 텍스트만 바꾸라는 패치. 가장 저렴한 변경입니다.',
        },
        {
          code: `  const changes = diffProps(oldVNode.props, newVNode.props);
  if (changes.length) patches.push({ type: 'PROPS', path, changes });

  diffChildren(oldVNode.children, newVNode.children, path, patches);
  return patches;
}`,
          note: '⑤ PROPS: 같은 태그면 노드는 재사용하고 바뀐 속성만 모아 패치 하나로. 그다음 자식 리스트 비교로 내려갑니다. ① INSERT 와 ② REMOVE 는 자식 리스트 비교(diffChildren)에서 생깁니다.',
        },
      ],
      explain: {
        q: '5가지 케이스는 각각 어디서 생기나요?',
        a: 'REPLACE 는 타입이나 key 가 다를 때, TEXT 는 텍스트 노드 글자가 다를 때, PROPS 는 같은 태그의 속성이 다를 때 diff() 에서 생깁니다. INSERT 와 REMOVE 는 자식 리스트를 비교하는 diffChildren() 에서, 짝이 없는 새 노드와 옛 노드로 생깁니다.',
      },
    },
    {
      id: 'children',
      group: 'Phase 1 · Diff',
      title: 'diffChildren() — 자식 리스트 비교 (key, 이동)',
      file: 'src/lib/diff.js',
      summary: '형제 리스트에서 같은 노드를 짝짓고, 삭제 → 이동/추가 → 재귀 순서로 패치를 만듭니다. 가장 핵심적이고 복잡한 부분입니다.',
      chunks: [
        {
          code: `// ---- 1. 매칭 ----
const keyed = new Map();      // key → 옛 노드
const unkeyed = [];           // key 없는 옛 노드들 (순서대로)
for (const c of oldCh) {
  if (c.key != null) keyed.set(c.key, c);
  else unkeyed.push(c);
}
newCh.forEach((c, i) => {
  let m = null;
  if (c.key != null) m = keyed.get(c.key);   // key 가 있으면 key 로
  else if (u < unkeyed.length) m = unkeyed[u++];  // 없으면 순서대로
  if (m) { used.add(m); matchOf[i] = m; }
});`,
          note: '새 리스트의 각 노드가 "옛 리스트의 어느 노드였는지" 짝을 짓습니다. key 가 있으면 key 로 찾고, 없으면 key 없는 것끼리 순서대로 짝짓습니다. 그래서 key 가 없으면 순서가 바뀌었을 때 엉뚱한 노드와 짝지어집니다.',
        },
        {
          code: `// ---- 2. 삭제 (뒤에서부터) ----
const live = oldCh.slice();   // 지금 DOM 의 형제 순서를 흉내 내는 배열
for (let i = live.length - 1; i >= 0; i--) {
  if (!used.has(live[i])) {
    patches.push({ type: 'REMOVE', path: parentPath, index: i, node: live[i] });
    live.splice(i, 1);
  }
}`,
          note: '② REMOVE: 짝이 없는 옛 노드는 지웁니다. 뒤에서부터 지우는 이유는, 앞을 먼저 지우면 뒤 항목들의 번호가 하나씩 당겨져 index 가 틀어지기 때문입니다. live 배열은 패치가 적용되는 동안 DOM 이 어떤 순서일지를 따라가는 시뮬레이션입니다.',
        },
        {
          code: `// ---- 3. 이동 / 삽입 ----
const seq = live.map((m) => newIndexOf.get(m));   // 남은 노드들이 가야 할 새 위치
const stable = new Set(longestIncreasingSubsequence(seq).map((k) => live[k]));`,
          note: '남은 옛 노드들이 새 리스트에서 몇 번째에 가야 하는지 수열로 만들고, 그 수열의 최장 증가 부분 수열(LIS)을 구합니다. LIS 에 든 노드들은 이미 서로의 순서가 맞으므로 움직이지 않습니다. → 이동 횟수가 최소가 됩니다.',
        },
        {
          code: `for (let i = newCh.length - 1; i >= 0; i--) {
  const anchor = i + 1 < newCh.length ? placed[i + 1] : null;  // 오른쪽 이웃
  const m = matchOf[i];
  if (m && stable.has(m)) { placed[i] = m; continue; }          // 그대로 둠
  if (m) {                                                      // 기존 노드 이동
    const from = live.indexOf(m);
    live.splice(from, 1);
    const to = anchor ? live.indexOf(anchor) : live.length;
    live.splice(to, 0, m);
    if (from !== to) patches.push({ type: 'MOVE', path: parentPath, from, to, key: m.key });
  } else {                                                      // 새 노드 추가
    const index = anchor ? live.indexOf(anchor) : live.length;
    live.splice(index, 0, { inserted: newCh[i] });
    patches.push({ type: 'INSERT', path: parentPath, index, node: newCh[i] });
  }
}`,
          note: '뒤에서부터 각 새 노드를 "오른쪽 이웃 바로 앞" 에 놓습니다. LIS 노드는 건너뛰고, 나머지 옛 노드는 MOVE, 짝이 없는 새 노드는 ① INSERT. 뒤에서부터 하면 오른쪽 이웃이 이미 제자리에 있으므로 기준점이 됩니다.',
        },
        {
          code: `// ---- 4. 재귀 diff (이제 live 순서 == newCh 순서) ----
for (let i = 0; i < newCh.length; i++) {
  const m = matchOf[i];
  if (m) diff(m, newCh[i], parentPath.concat(i), patches);
}`,
          note: '자리가 모두 확정된 뒤에야 짝지어진 노드끼리 안쪽을 비교합니다. 이때 path 에는 새 위치 i 가 들어갑니다. 자리가 이미 확정됐으니 이 번호는 더 이상 바뀌지 않습니다.',
        },
      ],
      explain: {
        q: '리스트 순서가 바뀌면 어떻게 최소한으로 처리하나요?',
        a: 'key 로 옛 노드와 새 노드를 짝짓고, 짝이 없는 옛 노드는 뒤에서부터 지웁니다. 남은 노드들의 새 위치 수열에서 최장 증가 부분 수열을 구해 그 노드들은 그대로 두고, 나머지만 오른쪽 이웃 앞으로 옮깁니다. 그래서 [A,B,C,D] → [B,C,D,A] 는 1번만 이동합니다.',
      },
    },
    {
      id: 'patch',
      group: 'Phase 1 · Patch',
      title: 'applyPatch() — 실제 DOM 에 반영',
      file: 'src/lib/patch.js',
      summary: '패치 하나를 받아 path 를 따라 대상 노드를 찾고, 종류에 맞는 DOM API 를 딱 한 번 호출합니다.',
      chunks: [
        {
          code: `export function resolvePath(root, path) {
  let node = root;
  for (const i of path) node = node.childNodes[i];
  return node;
}`,
          note: 'path [0, 2, 1] 은 "루트의 0번 자식 → 그 2번 자식 → 그 1번 자식" 이라는 주소입니다. 그래서 Phase 1 은 처음에 들여쓰기 공백을 지워서 childNodes 번호와 VNode 자식 번호를 맞춥니다.',
        },
        {
          code: `case 'REPLACE': {
  const target = resolvePath(root, p.path);
  const el = createElement(p.node, childNamespace(target.parentNode));
  target.parentNode.replaceChild(el, target);
  return el;
}
case 'TEXT':  resolvePath(root, p.path).nodeValue = p.text; ...
case 'PROPS': for (const c of p.changes) setProp(target, c.name, c.value, c.oldValue); ...`,
          note: '교체는 새 DOM 을 만들어 replaceChild, 텍스트는 nodeValue 만, 속성은 바뀐 것만 setProp. SVG 안이면 SVG 네임스페이스로 만듭니다.',
        },
        {
          code: `case 'INSERT': {
  const parent = resolvePath(root, p.path);
  parent.insertBefore(createElement(p.node, childNamespace(parent)), parent.childNodes[p.index] ?? null);
}
case 'REMOVE': parent.removeChild(parent.childNodes[p.index]); ...
case 'MOVE': {
  const child = parent.childNodes[p.from];
  parent.removeChild(child);
  parent.insertBefore(child, parent.childNodes[p.to] ?? null);   // 같은 노드를 옮김
}`,
          note: 'INSERT 는 새로 만들어 끼우고, REMOVE 는 빼고, MOVE 는 기존 노드를 빼서 다른 자리에 다시 끼웁니다. MOVE 는 노드를 새로 만들지 않으므로 그 안의 입력값·포커스·스크롤이 유지됩니다.',
        },
      ],
      explain: {
        q: '패치를 순서대로 적용해도 주소가 안 틀어지는 이유는?',
        a: 'diff 가 패치를 만들 때 live 배열로 DOM 순서 변화를 미리 흉내 내기 때문입니다. 한 부모 안에서 삭제(뒤에서부터) → 이동·추가 → 자식 재귀 순서로 패치를 만들어서, 앞에서부터 적용하면 각 패치가 가리키는 번호가 그 시점의 실제 DOM 과 일치합니다.',
      },
    },
    {
      id: 'render',
      group: 'Phase 2 · Hooks',
      title: 'render() + getHookSlot() — 상태가 유지되는 원리',
      file: 'src/lib/component.js',
      summary: '"함수는 매번 새로 실행되는데 상태는 어떻게 유지할까?" 에 대한 답입니다.',
      chunks: [
        {
          code: `render() {
  currentComponent = this;      // 지금 누가 렌더링 중인지 전역에 등록
  this.hookIndex = 0;           // 사물함 번호를 0번부터
  const expectedHooks = this.hooks.length;
  const out = resolve(this.fn(this.props));   // 함수 실행 + 자식 컴포넌트 펼치기`,
          note: '컴포넌트 함수를 부르기 직전에 "지금 렌더링 중인 컴포넌트" 를 전역 변수에 걸어 두고 번호를 0 으로 맞춥니다. 함수 안에서 불리는 useState 는 이 전역 변수를 보고 자기 컴포넌트의 hooks 배열을 찾습니다.',
        },
        {
          code: `  if (this.isMounted && this.hookIndex !== expectedHooks) {
    throw new Error('렌더링마다 Hook 호출 개수가 달라졌습니다 ...');
  }`,
          note: '렌더가 끝났을 때 Hook 을 부른 횟수가 지난번과 다르면 에러. 조건문 안에서 Hook 을 부르면 이렇게 됩니다.',
        },
        {
          code: `function getHookSlot(kind) {
  if (!currentComponent) throw new Error(\`\${kind} 는 렌더링 중에만 호출할 수 있습니다.\`);
  if (childDepth > 0) throw new Error(\`\${kind} 는 최상위(루트) 컴포넌트에서만 ...\`);
  const comp = currentComponent;
  const index = comp.hookIndex++;      // 호출 순서 = 사물함 번호
  const hook = comp.hooks[index];
  if (hook && hook.kind !== kind) throw new Error('Hook 호출 순서가 바뀌었습니다 ...');
  return { comp, index, hook };
}`,
          note: '모든 Hook 이 처음에 부르는 함수입니다. 번호를 하나 올려 자기 칸을 꺼냅니다. 자식 컴포넌트를 펼치는 중(childDepth > 0)이면 에러를 던져 "Hook 은 루트에서만" 이라는 과제 제약을 강제합니다. 칸의 종류가 다르면 순서가 바뀐 것이므로 에러.',
        },
      ],
      explain: {
        q: '함수가 매번 새로 실행되는데 상태는 어떻게 유지되나요?',
        a: '상태를 함수 안이 아니라 컴포넌트 인스턴스의 hooks 배열에 저장합니다. 렌더링 직전에 현재 컴포넌트를 전역에 등록하고 번호를 0 으로 맞춘 뒤, Hook 이 호출될 때마다 번호를 하나씩 올려 그 칸을 씁니다. 호출 순서가 곧 칸 번호라서 조건문 안에서 Hook 을 부르면 안 됩니다.',
      },
    },
    {
      id: 'usestate',
      group: 'Phase 2 · Hooks',
      title: 'useState() + scheduleUpdate() — setState 와 Batching',
      file: 'src/lib/component.js',
      summary: 'setState 가 하는 일과, 여러 setState 를 한 번의 렌더링으로 모으는 방법입니다.',
      chunks: [
        {
          code: `export function useState(initial) {
  const { comp, index, hook } = getHookSlot('useState');
  if (hook) return [hook.value, hook.setState];       // 두 번째 렌더부터: 저장된 값`,
          note: '이미 칸이 있으면 저장해 둔 값과 setState 를 그대로 돌려줍니다. 그래서 함수가 다시 실행돼도 값이 유지되고, setState 함수의 참조도 매번 같습니다.',
        },
        {
          code: `  const slot = { kind: 'useState', value: typeof initial === 'function' ? initial() : initial };
  slot.setState = (action) => {
    const next = typeof action === 'function' ? action(slot.value) : action;  // ① 새 값 계산
    if (Object.is(next, slot.value)) return;                                  // ② 같으면 멈춤
    slot.value = next;                                                        // ③ 저장
    comp.scheduleUpdate({ index, kind: 'useState' });                         // ④ 다시 그리기 예약
  };
  comp.hooks[index] = slot;
  return [slot.value, slot.setState];
}`,
          note: '처음엔 칸을 만듭니다. initial 이 함수면 한 번만 호출(지연 초기화). setState 는 ① 새 값 계산 ② 같은 값이면 아무것도 안 함 ③ 칸에 저장 ④ 렌더링 예약, 네 가지를 합니다. 바로 렌더링하지 않는다는 게 핵심입니다.',
        },
        {
          code: `scheduleUpdate(reason) {
  if (reason) this.updateReasons.push(reason);
  if (this.updateScheduled) return;        // 이미 예약돼 있으면 또 예약하지 않음
  this.updateScheduled = true;
  queueMicrotask(() => this.update());     // 지금 실행 중인 코드가 끝나면 한 번만
}`,
          note: 'Batching: 첫 setState 가 microtask 하나를 예약하고, 같은 핸들러 안의 다음 setState 들은 "이미 예약됨" 이라 그냥 돌아갑니다. 핸들러가 끝나면 예약된 update() 가 한 번만 실행됩니다. 원인 기록(updateReasons)은 Inspector 가 "setState ×3 → 렌더 1회" 를 보여줄 때 씁니다.',
        },
      ],
      explain: {
        q: 'setState 는 상태 변경 외에 무엇을 하나요? Batching 은 어떻게 했나요?',
        a: '같은 값이면 건너뛰고, 다르면 저장한 뒤 렌더링을 바로 하지 않고 예약합니다. 예약은 queueMicrotask 로 하고 이미 예약돼 있으면 다시 하지 않아서, 한 핸들러 안의 여러 setState 가 끝난 뒤 렌더링이 한 번만 일어납니다.',
      },
    },
    {
      id: 'update',
      group: 'Phase 2 · Hooks',
      title: 'update() + commit() — Phase 1 엔진 재사용',
      file: 'src/lib/component.js',
      summary: '상태가 바뀐 뒤의 전체 흐름. Phase 1 의 diff 와 applyPatches 를 그대로 씁니다.',
      chunks: [
        {
          code: `update() {
  this.flushPassiveEffects();                     // 밀린 useEffect 가 있으면 먼저
  const next = this.render();                     // 1. 새 Virtual DOM
  const patches = diff(this.vnode, next);         // 2. 이전과 비교 (Phase 1)
  this.dom = applyPatches(this.dom, patches);     // 3. 바뀐 곳만 반영 (Phase 1)
  this.vnode = next;                              // 4. 다음 비교를 위해 보관
  this.commit({ type: 'update', patches, ... });
}`,
          note: '과제의 "Phase 1 ↔ Phase 2 연계" 가 바로 이 네 줄입니다. 새 VDOM 생성 → 이전 VDOM 과 diff → 바뀐 부분만 patch. 전체를 다시 그리지 않습니다.',
        },
        {
          code: `commit(info) {
  runEffects(this.renderEffects.layout);            // useLayoutEffect: 지금 바로 (그리기 전)
  this.pendingPassive.push(...this.renderEffects.passive);
  afterPaint(() => this.flushPassiveEffects());     // useEffect: 화면을 그린 뒤
  this.onCommit?.(...);
}`,
          note: 'DOM 반영이 끝나면 useLayoutEffect 는 즉시 실행하고, useEffect 는 브라우저가 화면을 그린 뒤로 미룹니다 (requestAnimationFrame 안에서 setTimeout). 그래서 useEffect 는 화면 표시를 늦추지 않습니다.',
        },
        {
          code: `function runEffects(list) {
  for (const { slot } of list) if (typeof slot.cleanup === 'function') slot.cleanup();  // 먼저 모든 정리
  for (const { slot, effect } of list) {
    const cleanup = effect();                                                     // 그다음 모든 실행
    slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }
}`,
          note: '이전 effect 의 cleanup 을 모두 먼저 부르고, 새 effect 를 실행합니다. effect 가 함수를 돌려주면 다음번(또는 언마운트 때) 부를 cleanup 으로 저장합니다.',
        },
      ],
      explain: {
        q: 'Phase 1 과 Phase 2 는 어떻게 연결되나요?',
        a: 'Phase 2 의 update() 가 컴포넌트를 다시 실행해 새 Virtual DOM 을 만든 뒤, Phase 1 에서 만든 diff() 로 이전 Virtual DOM 과 비교하고 applyPatches() 로 바뀐 부분만 실제 DOM 에 반영합니다. Phase 1 은 사람이 Patch 버튼을 누르고, Phase 2 는 setState 가 그 과정을 자동으로 일으키는 차이입니다.',
      },
    },
    {
      id: 'memo',
      group: 'Phase 2 · Hooks',
      title: 'useEffect / useMemo — 의존성 배열',
      file: 'src/lib/component.js',
      summary: '"의존성이 바뀌었을 때만" 다시 하는 Hook 들의 공통 원리입니다.',
      chunks: [
        {
          code: `export function depsChanged(prev, next) {
  if (next === undefined || prev === undefined) return true;   // 배열 없음 → 매번
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (!Object.is(prev[i], next[i])) return true;
  return false;
}`,
          note: '의존성 배열을 이전 것과 한 칸씩 Object.is 로 비교합니다. 배열 자체가 없으면 항상 "바뀜". 객체나 함수를 넣으면 렌더마다 새로 만들어져 매번 바뀐 것으로 보입니다.',
        },
        {
          code: `export function useMemo(factory, deps) {
  const { comp, index, hook } = getHookSlot('useMemo');
  if (hook && !depsChanged(hook.deps, deps)) return hook.value;   // 그대로면 저장된 값
  const value = factory();                                         // 바뀌었으면 다시 계산
  comp.hooks[index] = { kind: 'useMemo', value, deps };
  return value;
}`,
          note: '의존성이 같으면 계산 함수를 부르지도 않고 칸에 저장된 결과를 돌려줍니다. 결과가 VNode 면 diff 의 "같은 객체면 건너뛰기" 와 만나 하위 비교까지 생략됩니다.',
        },
        {
          code: `function effectHook(kind, phase, effect, deps) {
  const slot = hook ?? (comp.hooks[index] = { kind, deps: undefined, cleanup: null, ran: false });
  if (!slot.ran || depsChanged(slot.deps, deps)) {
    slot.deps = deps;
    slot.ran = true;
    comp.renderEffects[phase].push({ slot, effect });   // 실행이 아니라 "예약"
  }
}`,
          note: 'useEffect 와 useLayoutEffect 는 렌더 중에 effect 를 실행하지 않고 예약만 합니다. 렌더는 순수 계산이어야 하기 때문입니다. 실제 실행은 commit 에서.',
        },
      ],
      explain: {
        q: 'useEffect 와 useMemo 의 의존성 배열은 어떻게 동작하나요?',
        a: '이전 렌더에 저장해 둔 의존성 배열과 이번 배열을 한 칸씩 Object.is 로 비교해서, 하나라도 다르면 useMemo 는 다시 계산하고 useEffect 는 실행을 예약합니다. 배열을 생략하면 매번, 빈 배열이면 처음 한 번만입니다.',
      },
    },
  ];

  // ============================================================ 렌더링
  const toc = document.getElementById('wt-toc');
  const root = document.getElementById('wt-content');
  let group = null;
  for (const s of SECTIONS) {
    if (s.group !== group) {
      group = s.group;
      const g = document.createElement('div');
      g.className = 'wt-group';
      g.textContent = group;
      toc.append(g);
      const part = document.createElement('div');
      part.className = 'wt-part';
      part.textContent = group;
      root.append(part);
    }
    const a = document.createElement('a');
    a.href = `#${s.id}`;
    a.textContent = s.title.split(' — ')[0];
    toc.append(a);

    const sec = document.createElement('section');
    sec.className = 'card wt-sec';
    sec.id = s.id;
    sec.innerHTML = `<div class="wt-head"><h2></h2><code class="wt-file"></code></div><p class="wt-sum"></p><div class="wt-chunks"></div>`;
    sec.querySelector('h2').textContent = s.title;
    sec.querySelector('.wt-file').textContent = s.file;
    sec.querySelector('.wt-sum').textContent = s.summary;
    const chunks = sec.querySelector('.wt-chunks');
    s.chunks.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'wt-row';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = c.code;
      pre.append(code);
      const note = document.createElement('div');
      note.className = 'wt-note';
      const num = document.createElement('span');
      num.className = 'wt-num';
      num.textContent = i + 1;
      const text = document.createElement('p');
      text.textContent = c.note;
      note.append(num, text);
      row.append(pre, note);
      chunks.append(row);
    });
    const ex = document.createElement('div');
    ex.className = 'wt-explain';
    ex.innerHTML = `<b>🗣 설명 연습</b><p class="q"></p><textarea placeholder="내 말로 3문장 안에 설명해 보세요. (이 브라우저에 저장됩니다)" aria-label="설명 연습"></textarea><details><summary>모범 답안 보기</summary><p class="a"></p></details>`;
    ex.querySelector('.q').textContent = `Q. ${s.explain.q}`;
    ex.querySelector('.a').textContent = s.explain.a;
    const ta = ex.querySelector('textarea');
    const key = `mini-react-walkthrough:${s.id}`;
    try { ta.value = localStorage.getItem(key) ?? ''; } catch (e) { /* 저장 불가 */ }
    ta.addEventListener('input', () => { try { localStorage.setItem(key, ta.value); } catch (e) { /* 저장 불가 */ } });
    sec.append(ex);
    root.append(sec);
  }

  // 목차 현재 위치
  const links = [...toc.querySelectorAll('a')];
  const io = new (window.IntersectionObserver || NoopObserver)((entries) => {
    for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }, { rootMargin: '-80px 0px -70% 0px' });
  document.querySelectorAll('.wt-sec').forEach((s) => io.observe(s));
})();
