import type {
  DevConsoleMessage,
  DevDiagnostics,
  DevNoticeEvent,
  DevRuntimeError,
} from "../core/types";

const DIAGNOSTICS_NAMESPACE = "__obsidianE2EDiagnostics";

export type DiagnosticsMethod =
  | "consoleMessages"
  | "diagnostics"
  | "notices"
  | "reset"
  | "runtimeErrors";

export function buildDiagnosticsCode(method: DiagnosticsMethod): string {
  return [
    "(()=>{",
    `const __obsidianE2EMethod=${JSON.stringify(method)};`,
    `const __obsidianE2ENamespace=${JSON.stringify(DIAGNOSTICS_NAMESPACE)};`,
    "const __obsidianE2EMaxEntries=100;",
    "const __obsidianE2EPush=(entries,value)=>{if(entries.length>=__obsidianE2EMaxEntries){entries.shift();}entries.push(value);};",
    "const __obsidianE2EFormat=(value)=>{if(typeof value==='string'){return value;}try{return JSON.stringify(value);}catch{return String(value);}};",
    "const __obsidianE2EClone=(value)=>{try{return JSON.parse(JSON.stringify(value));}catch{return __obsidianE2EFormat(value);}};",
    "const __obsidianE2EPushRuntimeError=(source,errorLike,state)=>{const message=errorLike&&typeof errorLike==='object'&&'message' in errorLike?String(errorLike.message):String(errorLike);const stack=errorLike&&typeof errorLike==='object'&&'stack' in errorLike?String(errorLike.stack):undefined;__obsidianE2EPush(state.runtimeErrors,{at:Date.now(),message,source,stack});};",
    "const root=globalThis;",
    "const state=root[__obsidianE2ENamespace]??(root[__obsidianE2ENamespace]={consoleMessages:[],notices:[],runtimeErrors:[],consolePatched:false,noticeObserved:false,runtimePatched:false});",
    "if(!state.consolePatched&&root.console){for(const level of ['debug','error','info','log','warn']){const original=root.console?.[level];if(typeof original!=='function'){continue;}root.console[level]=(...args)=>{__obsidianE2EPush(state.consoleMessages,{args:args.map(__obsidianE2EClone),at:Date.now(),level,text:args.map(__obsidianE2EFormat).join(' ')});return original.apply(root.console,args);};}state.consolePatched=true;}",
    "if(!state.runtimePatched&&typeof root.addEventListener==='function'){root.addEventListener('error',(event)=>{__obsidianE2EPushRuntimeError('error',event?.error??event?.message??'Unknown error',state);});root.addEventListener('unhandledrejection',(event)=>{__obsidianE2EPushRuntimeError('unhandledrejection',event?.reason??'Unhandled rejection',state);});state.runtimePatched=true;}",
    // Record notices from the DOM: plugins construct the `Notice` they imported from
    // "obsidian", so replacing the `window.Notice` global never sees them.
    "if(!state.noticeObserved&&typeof root.MutationObserver==='function'&&root.document?.body){const seen=new WeakSet();const record=(el)=>{if(seen.has(el)){return;}seen.add(el);__obsidianE2EPush(state.notices,{at:Date.now(),message:(el.querySelector('.notice-message')??el).textContent??''});};new root.MutationObserver((mutations)=>{for(const mutation of mutations){for(const node of mutation.addedNodes){if(node.classList?.contains('notice')&&node.parentElement?.classList.contains('notice-container')){record(node);}else if(node.classList?.contains('notice-container')){for(const notice of node.querySelectorAll(':scope > .notice')){record(notice);}}}}}).observe(root.document.body,{childList:true,subtree:true});state.noticeObserved=true;}",
    "if(__obsidianE2EMethod==='reset'){state.consoleMessages.splice(0);state.notices.splice(0);state.runtimeErrors.splice(0);return true;}",
    "if(__obsidianE2EMethod==='consoleMessages'){return state.consoleMessages;}",
    "if(__obsidianE2EMethod==='notices'){return state.notices;}",
    "if(__obsidianE2EMethod==='runtimeErrors'){return state.runtimeErrors;}",
    "return {consoleMessages:state.consoleMessages,notices:state.notices,runtimeErrors:state.runtimeErrors};",
    "})()",
  ].join("");
}

export function createDevDiagnostics(value: DevDiagnostics | null | undefined): DevDiagnostics {
  return {
    consoleMessages: (value?.consoleMessages ?? []) as DevConsoleMessage[],
    notices: (value?.notices ?? []) as DevNoticeEvent[],
    runtimeErrors: (value?.runtimeErrors ?? []) as DevRuntimeError[],
  };
}
