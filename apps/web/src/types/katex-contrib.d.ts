/**
 * W865 · KaTeX contrib 的模块声明（类型补丁，零运行时影响）。
 *
 * katex 0.18.7 的 package.json exports 暴露 ./contrib/*（import -> dist/contrib/*.mjs），
 * 但随包的 types/ 只有 katex.d.ts，没有 contrib 的 .d.ts；moduleResolution:"bundler" 下
 * `import('katex/contrib/mhchem')` 会报 TS7016（Could not find a declaration file）。
 * mhchem 是副作用模块（对 katex 实例注册 \ce/\pu 宏），不需要类型；这里声明成无类型模块。
 * 唯一引入点是 ui/messages/math.ts 的动态 import，加载失败另有 fail-soft 兜底。
 */
declare module 'katex/contrib/mhchem';
