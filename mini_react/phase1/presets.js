/**
 * Phase 1 예시 케이스
 * ------------------------------------------------------------------
 * 현재 Virtual DOM 을 복사해서 한 가지 변경을 가한 "새 Virtual DOM" 을 만든다.
 * (사용자가 테스트 영역을 손으로 고친 것과 같은 효과)
 * 버튼을 여러 번 눌러도 동작하도록 대부분 토글/순환 방식이다.
 * 대상 노드를 찾지 못하면 null 을 반환한다. (사용자가 이미 지운 경우)
 */
import { TEXT, createText } from '../src/lib/vdom.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 깊이 우선으로 조건에 맞는 첫 노드 */
export function findNode(v, pred) {
  if (pred(v)) return v;
  for (const c of v.children ?? []) {
    const r = findNode(c, pred);
    if (r) return r;
  }
  return null;
}

const hasClass = (name) => (n) => typeof n.props?.class === 'string' && n.props.class.split(/\s+/).includes(name);
const el = (type, props, ...children) => ({
  type,
  props: props ?? {},
  key: props?.key ?? props?.['data-key'] ?? null,
  children: children.map((c) => (typeof c === 'string' ? createText(c) : c)),
});

const NEW_SKILLS = ['TypeScript', 'CSS', 'Testing', 'Node.js', 'Git'];

export const PRESETS = [
  {
    id: 'text',
    type: 'TEXT',
    label: '이름 바꾸기',
    desc: 'h2 안의 텍스트 노드 하나만 바뀝니다. DOM 노드는 그대로, nodeValue 만 수정.',
    apply(root) {
      const v = clone(root);
      const h2 = findNode(v, (n) => n.type === 'h2');
      const t = h2?.children.find((c) => c.type === TEXT);
      if (!t) return null;
      t.text = t.text.startsWith('김정글') ? t.text.replace('김정글', '박정글') : t.text.replace(/^\S+/, '김정글');
      return v;
    },
  },
  {
    id: 'props',
    type: 'PROPS',
    label: '테마 바꾸기',
    desc: '같은 <article> 의 data-theme 속성만 바뀝니다. 자식은 비교만 하고 건드리지 않음.',
    apply(root) {
      const v = clone(root);
      const card = findNode(v, hasClass('profile'));
      if (!card) return null;
      card.props['data-theme'] = card.props['data-theme'] === 'dark' ? 'light' : 'dark';
      return v;
    },
  },
  {
    id: 'insert',
    type: 'INSERT',
    label: '스킬 추가',
    desc: '리스트 끝에 <li> 하나가 새로 생깁니다. 기존 <li> 들은 재사용.',
    apply(root) {
      const v = clone(root);
      const ul = findNode(v, hasClass('skills'));
      if (!ul) return null;
      const used = new Set(ul.children.map((c) => c.key));
      const name = NEW_SKILLS.find((s) => !used.has(s.toLowerCase())) ?? `Skill ${ul.children.length + 1}`;
      ul.children.push(el('li', { key: name.toLowerCase() }, name));
      return v;
    },
  },
  {
    id: 'remove',
    type: 'REMOVE',
    label: '스킬 삭제',
    desc: '리스트의 마지막 <li> 하나만 제거됩니다.',
    apply(root) {
      const v = clone(root);
      const ul = findNode(v, hasClass('skills'));
      if (!ul || ul.children.length === 0) return null;
      ul.children.pop();
      return v;
    },
  },
  {
    id: 'replace',
    type: 'REPLACE',
    label: '태그 바꾸기',
    desc: '<p> 가 <blockquote> 로 바뀌면 타입이 달라서 하위 트리를 통째로 새로 만듭니다.',
    apply(root) {
      const v = clone(root);
      const bio = findNode(v, hasClass('bio'));
      if (!bio) return null;
      bio.type = bio.type === 'p' ? 'blockquote' : 'p';
      return v;
    },
  },
  {
    id: 'move',
    type: 'MOVE',
    label: '순서 섞기',
    desc: '마지막 스킬을 맨 앞으로. key 가 있어서 새로 만들지 않고 기존 노드를 옮깁니다 (MOVE 1번).',
    apply(root) {
      const v = clone(root);
      const ul = findNode(v, hasClass('skills'));
      if (!ul || ul.children.length < 2) return null;
      ul.children.unshift(ul.children.pop());
      return v;
    },
  },
  {
    id: 'row',
    type: 'INSERT',
    label: '표에 행 추가',
    desc: '<tbody> 에 <tr> 이 하나 추가됩니다. 표 전체를 다시 그리지 않음.',
    apply(root) {
      const v = clone(root);
      const tbody = findNode(v, (n) => n.type === 'tbody');
      if (!tbody) return null;
      const subjects = ['네트워크', '데이터베이스', '컴퓨터구조', '자료구조', '보안'];
      const name = subjects[tbody.children.length % subjects.length];
      const score = String(70 + ((tbody.children.length * 7) % 30));
      tbody.children.push(el('tr', { key: `row-${tbody.children.length}` }, el('td', null, name), el('td', null, score)));
      return v;
    },
  },
  {
    id: 'score',
    type: 'TEXT',
    label: '점수 올리기',
    desc: '표 첫 행의 점수 텍스트만 바뀝니다. 진행 바(SVG)의 width 도 함께 바뀌어 PROPS 가 생깁니다.',
    apply(root) {
      const v = clone(root);
      const td = findNode(v, (n) => n.type === 'td' && /^\d+$/.test(n.children[0]?.text ?? ''));
      if (!td) return null;
      const next = (Number(td.children[0].text) + 3) % 101;
      td.children[0].text = String(next);
      const bars = [];
      (function walk(n) {
        if (n.type === 'rect') bars.push(n);
        (n.children ?? []).forEach(walk);
      })(v);
      if (bars[1]) bars[1].props.width = String(Math.round((next / 100) * 120));
      return v;
    },
  },
  {
    id: 'combo',
    type: 'MIX',
    label: '한꺼번에 여러 개',
    desc: '텍스트, 속성, 추가, 이동을 동시에. 패치 로그에서 여러 종류가 섞여 나오는 것을 확인하세요.',
    apply(root) {
      let v = root;
      // 이동을 먼저 해야 "기존" 항목이 움직인다 (추가 후 이동하면 새 항목이 옮겨져 INSERT 하나로 합쳐짐)
      for (const id of ['text', 'props', 'move', 'insert']) {
        const next = PRESETS.find((p) => p.id === id).apply(v);
        if (next) v = next;
      }
      return v === root ? null : v;
    },
  },
];
