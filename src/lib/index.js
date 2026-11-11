export {
  TEXT, SVG_NS, h, createText, domToVNode, containerToVNode, htmlToVNode, normalizeDom,
  createElement, setProp, vnodeToHTML, childrenToHTML, countNodes, focusedKeys,
} from './vdom.js';
export { diff, diffProps, diffChildren, PatchType, longestIncreasingSubsequence, summarizePatches } from './diff.js';
export { applyPatches, applyPatch, resolvePath, moveNode, applyPatchesToVNode } from './patch.js';
export { StateHistory, DeltaHistory } from './history.js';
export {
  FunctionComponent, mount, resolve,
  useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useReducer,
  createContext, useContext,
} from './component.js';
export { devConfig, warn, resetWarnings } from './warn.js';
