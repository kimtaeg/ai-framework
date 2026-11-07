// 미니 레디스 샌드박스 — 화면은 week2/shared/sandbox-ui.js (1주차 샌드박스와 같은 구조)
import { TEMPLATES, SNIPPETS } from './templates.js';
import { mountSandbox } from '../../shared/sandbox-ui.js';

mountSandbox({ templates: TEMPLATES, snippets: SNIPPETS, storeKey: 'mini-redis-sandbox:v1', showKeys: true, showTables: false });
