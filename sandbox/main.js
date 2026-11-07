/**
 * miniReact 샌드박스
 *  편집기에 쓴 코드를 실행해서, 그 안의 App 함수를 FunctionComponent 로 마운트한다.
 *  코드는 이 브라우저에서만 실행되고, localStorage 에 자동 저장된다.
 */
import { h } from '../src/lib/vdom.js';
import {
  FunctionComponent, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer,
  createContext, useContext,
} from '../src/lib/component.js';
import { devConfig, resetWarnings } from '../src/lib/warn.js';
import { createInspector } from '../tools/inspector.js';
import { TEMPLATES, SNIPPETS } from './templates.js';

const $ = (s) => document.querySelector(s);
const editor = $('#code');
const gutter = $('#gutter');
const previewEl = $('#preview');
const errorBox = $('#error');
const consoleBox = $('#console');
const STORE = 'mini-react-sandbox:v1';

const API = { h, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer, createContext, useContext };
const inspector = createInspector($('#inspector'), { observe: previewEl, title: 'Inspector', maxLog: 20 });

let comp = null;
let current = TEMPLATES[1];

// ============================================================ 저장 / 불러오기
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ code: editor.value, template: current.id }));
    $('#saved').textContent = '자동 저장됨';
  } catch {
    $('#saved').textContent = '저장 불가 (브라우저 설정)';
  }
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE));
    if (data?.code) {
      current = TEMPLATES.find((t) => t.id === data.template) ?? TEMPLATES[0];
      return data.code;
    }
  } catch { /* 무시 */ }
  return null;
}

// ============================================================ 콘솔 (사용자 코드의 console.log 와 miniReact 경고)
function logLine(kind, args) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ');
  consoleBox.append(li);
  while (consoleBox.children.length > 100) consoleBox.firstChild.remove();
  consoleBox.scrollTop = consoleBox.scrollHeight;
  $('#console-count').textContent = consoleBox.children.length;
}
function safeString(v) {
  try {
    return typeof v === 'function' ? 'ƒ' : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const userConsole = {
  log: (...a) => logLine('log', a),
  info: (...a) => logLine('log', a),
  warn: (...a) => logLine('warn', a),
  error: (...a) => logLine('error', a),
};
devConfig.warnings = true;
devConfig.onWarn = (m) => logLine('warn', [`⚠ miniReact 경고: ${m}`]);

// ============================================================ 실행
/** new Function 의 몇 번째 줄이 사용자 코드의 1번째 줄인지 (함수 머리 2줄 + "use strict" 1줄) */
const LINE_OFFSET = 3;

function lineOf(error) {
  // 사용자 코드(new Function 으로 만든 함수)의 프레임만 본다
  //   Chrome/Edge: "(eval at run (…/main.js:120:21), <anonymous>:4:31)"   Firefox: "… > Function:4:31"
  const stack = String(error?.stack ?? '');
  const m = stack.match(/eval at run[^\n]*?<anonymous>:(\d+):(\d+)/) ?? stack.match(/> Function:(\d+):(\d+)/);
  if (!m) return null;
  const line = Number(m[1]) - LINE_OFFSET;
  return line > 0 ? line : null;
}

function showError(error, where) {
  const line = lineOf(error);
  errorBox.hidden = false;
  errorBox.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = `${where} 에러${line ? ` (약 ${line}번째 줄)` : ''}`;
  const p = document.createElement('div');
  p.textContent = error?.message ?? String(error);
  errorBox.append(b, p);
  logLine('error', [`${where}: ${error?.message ?? error}`]);
  if (line) markLine(line);
}

function markLine(line) {
  [...gutter.children].forEach((el, i) => el.classList.toggle('err', i + 1 === line));
}

function run() {
  errorBox.hidden = true;
  markLine(-1);
  if (comp) {
    try { comp.unmount(); } catch (e) { logLine('error', [`이전 앱 정리 중 에러: ${e.message}`]); }
    comp = null;
  }
  previewEl.replaceChildren();
  inspector.reset();
  resetWarnings();
  logLine('sys', [`── 실행 (${new Date().toLocaleTimeString()}) ──`]);

  let App;
  try {
    // 사용자 코드에서 쓸 수 있는 이름만 매개변수로 넘긴다
    const factory = new Function(...Object.keys(API), 'console', `"use strict";\n${editor.value}\n;return typeof App === 'function' ? App : undefined;`);
    App = factory(...Object.values(API), userConsole);
  } catch (e) {
    showError(e, '문법');
    return;
  }
  if (!App) {
    showError(new Error('App 함수를 찾지 못했습니다. function App() { return h(...) } 를 만들어 주세요.'), '실행');
    return;
  }

  comp = new FunctionComponent(App, {}, {
    onCommit: inspector.onCommit,
    onEffects: inspector.onEffects,
    onError: (e) => showError(e, '렌더링'),
  });
  try {
    comp.mount(previewEl);
  } catch (e) {
    showError(e, '렌더링');
  }
}

// 이벤트 핸들러 안에서 난 에러도 보여준다
window.addEventListener('error', (e) => {
  if (!comp) return;
  showError(e.error ?? new Error(e.message), '이벤트 핸들러');
});
window.addEventListener('unhandledrejection', (e) => showError(e.reason, '비동기'));

// ============================================================ 편집기
function updateGutter() {
  const n = editor.value.split('\n').length;
  if (gutter.children.length !== n) {
    gutter.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const d = document.createElement('div');
      d.textContent = i + 1;
      return d;
    }));
  }
  gutter.scrollTop = editor.scrollTop;
}

function setCode(code) {
  editor.value = code;
  updateGutter();
  save();
}

/** 커서 위치에 코드 끼워 넣기 (현재 줄의 들여쓰기에 맞춤) */
function insertAtCursor(code) {
  const { selectionStart: s, selectionEnd: e, value } = editor;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const indent = value.slice(lineStart, s).match(/^\s*/)[0];
  const atLineStart = value.slice(lineStart, s).trim() === '';
  const text = code.split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
  const insert = atLineStart ? text : `\n${indent}${text}`;
  editor.value = value.slice(0, s) + insert + value.slice(e);
  editor.selectionStart = editor.selectionEnd = s + insert.length;
  editor.focus();
  updateGutter();
  save();
  scheduleAuto();
}

editor.addEventListener('keydown', (e) => {
  const { selectionStart: s, selectionEnd: end, value } = editor;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    editor.value = value.slice(0, s) + '  ' + value.slice(end);
    editor.selectionStart = editor.selectionEnd = s + 2;
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // 자동 들여쓰기: 현재 줄 들여쓰기 유지, { ( [ 로 끝나면 한 단계 더
    e.preventDefault();
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, s);
    let indent = line.match(/^\s*/)[0];
    if (/[{([]\s*$/.test(line)) indent += '  ';
    const ins = '\n' + indent;
    editor.value = value.slice(0, s) + ins + value.slice(end);
    editor.selectionStart = editor.selectionEnd = s + ins.length;
    updateGutter();
  }
});
let autoTimer;
function scheduleAuto() {
  if (!$('#auto').checked) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(run, 900);
}
editor.addEventListener('input', () => {
  updateGutter();
  $('#saved').textContent = '저장 중…';
  clearTimeout(save.t);
  save.t = setTimeout(save, 400);
  scheduleAuto();
});
editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });

// ============================================================ 틀 / 조각 버튼
function selectTemplate(t, { replace = true } = {}) {
  current = t;
  document.querySelectorAll('.tpl').forEach((b) => b.classList.toggle('on', b.dataset.id === t.id));
  $('#tpl-desc').textContent = t.desc;
  $('#tpl-try').replaceChildren(...t.try.map((x) => {
    const li = document.createElement('li');
    li.textContent = x;
    return li;
  }));
  if (replace) {
    setCode(t.code);
    run();
  }
}

$('#tpl-list').replaceChildren(...TEMPLATES.map((t) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tpl small';
  b.dataset.id = t.id;
  b.textContent = t.name;
  b.addEventListener('click', () => {
    const dirty = editor.value.trim() && editor.value !== current.code;
    if (dirty && !confirm(`"${t.name}" 틀로 바꾸면 지금 편집기 내용이 사라집니다. 바꿀까요?`)) return;
    selectTemplate(t);
  });
  return b;
}));

const groups = [...new Set(SNIPPETS.map((s) => s.group))];
$('#snip-list').replaceChildren(...groups.map((g) => {
  const wrap = document.createElement('div');
  wrap.className = 'snip-group';
  const label = document.createElement('span');
  label.className = 'snip-label';
  label.textContent = g;
  wrap.append(label);
  for (const s of SNIPPETS.filter((x) => x.group === g)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'snip small';
    b.textContent = `+ ${s.label}`;
    b.title = s.code;
    // mousedown 에서 기본 동작을 막아야 편집기의 커서(선택 위치)가 유지된다
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => insertAtCursor(s.code));
    wrap.append(b);
  }
  return wrap;
}));

$('#run').addEventListener('click', run);
$('#reset').addEventListener('click', () => {
  if (editor.value !== current.code && !confirm(`"${current.name}" 틀의 처음 코드로 되돌릴까요?`)) return;
  setCode(current.code);
  run();
});
$('#clear-console').addEventListener('click', () => {
  consoleBox.replaceChildren();
  $('#console-count').textContent = '0';
});

// ============================================================ 시작
const saved = load();
selectTemplate(current, { replace: !saved });
if (saved) {
  setCode(saved);
  run();
}
window.__sandbox = { run, get comp() { return comp; } };
