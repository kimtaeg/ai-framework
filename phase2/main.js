import { FunctionComponent } from '../src/lib/component.js';
import { devConfig } from '../src/lib/warn.js';
import { createInspector } from '../tools/inspector.js';
import { App } from './app.js';

const root = document.querySelector('#root');
const inspector = createInspector(document.querySelector('#inspector'), { observe: root });

// 개발 모드 경고(key 누락 등)는 콘솔(F12)에 표시된다
devConfig.warnings = true;

const app = new FunctionComponent(App, {}, {
  onCommit: inspector.onCommit,
  onEffects: inspector.onEffects,
  onError: (e) => console.error(e),
});
app.mount(root);

window.__app = app; // 디버깅용: __app.hooks 로 상태 저장소를 직접 확인할 수 있다
