# Piper 速查表

一页看完写 Piper(编排语言)要会的全部:**12 个编排词 + 一小撮 Scheme 基础**。

```sh
make repl                          # REPL
make run FILE=examples/panel.piper # 跑一个程序
make test                          # 测试
```

---

## 编排核心词汇(~12,正交)

约定:**worker = `(lambda (task) -> 结果)`;只有 `model`/`agent` 两个构造器;控制平面对 worker 类型一视同仁。**

| 组 | 名字 | 签名 / 作用 | 例 |
|---|---|---|---|
| worker 构造 | `model` | `(model 名字)` → worker;`(model 名字 任务)` 直接问一次 | `(model "deepseek-v4-pro" "解释尾递归")` |
| | `agent` | `(agent 目录)` → worker;`(agent 目录 任务)` 直接派一次 | `(agent "./sb" "修 bug")` |
| 控制平面 | `fan-out` | `(fan-out workers task)` → 全部结果 | `(fan-out (map model ms) q)` |
| | `best` | `(best workers task score)` → 最优;**score 可直接写标准字符串**(自动 judge) | `(best ws q "准确且简洁")` |
| | `vote` | `(vote workers task)` → 多数表决 | `(vote (map model ms) q)` |
| | `amb` / `require` | 回溯搜索;`amb*` 对列表;`require` 假则回溯 | `(let ((x (amb* cs))) (require (ok? x)) x)` |
| | `loop` | 迭代:`(until p)`/`(times n)`/`(every s)`/`(self-paced)` | `(loop (until (green?)) (一轮))` |
| | `goal` | 单 worker 自主追目标 | `(goal "到30" (success? p) (tools ts) (max-steps 12))` |
| 认知动词 | `ask` | `(ask task)` → 文本(默认模型) | `(ask "一句话解释闭包")` |
| | `judge` | `(judge 标准 内容)` → 0~10(给 `best` 当 score) | `(judge "准确且简洁" 答案)` |
| | `propose` | `(propose n task)` → 候选列表(给 `amb*` 当搜索空间) | `(propose 4 "修复思路")` |

`fan-out`/`best`/`vote` 一套打通"多模型合议"与"多 agent 竞争";`judge`→`best` 的 score、`propose`→`amb*` 的候选——认知动词与组合子咬合。

## 两层 + 边界规则

| 层 | 后端 | 性质 | 判定 |
|---|---|---|---|
| 认知层 | `llm`(`model`/`ask`/`judge`/`propose`) | 纯、无副作用、只看 prompt | **不碰环境** |
| 执行层 | `pi`(`agent`) | 重、有工具+循环+副作用 | **在真实环境干活** |

> 认知层只看你喂进 prompt 的东西。要参考本地代码 → 控制平面 `(read-files paths)` 读出来拼进 prompt;"该看哪些代码"本身要探索 → 派 `(agent dir)`。**llm/pi 的边界 = 碰不碰环境。**

---

## Scheme 基础

### 特殊形式(14)
```
quote(')  if  cond  and  or  begin
define  lambda  set!
let  let*  letrec        ; 含具名 let:(let loop ((x 0)) ... (loop (+ x 1)))
define-macro  call/cc
```
加宏:`when` `unless`(prelude)。

### 常用库过程
**列表 / 解构**(组合结果、拆 `(退出码 . 输出)`)
```
list  cons  car  cdr  cadr  caddr  cadddr
map  filter  foldl  foldr  for-each
length  append  reverse  zip  range  assoc  member
```
**判断 / 比较 / 算术**
```
= < > <= >=   eq?  equal?  not
null?  pair?  number?  string?  symbol?  procedure?
+ - * /  add1  sub1  modulo  min  max
```
**字符串**(拼 prompt / 解析输出)
```
fmt("按思路:{}" idea —— {} 依次插值,取代 string-append)
string-append  number->string  string->number  string-trim
->string(display 风格)   repr(write 风格,适合 s-expr)
```
**真实世界 / 元**
```
shell  shell-ok?(退出码 0?)  read-file  write-file  read-files  file-exists?
capture  restore                                          ; 事务(Piper 自身状态)
redefine!  improve!  evolve!                              ; 运行时自修改
eval  llm-code  procedure-source  try                     ; 求值 / 模型输出→数据 / 安全调用
```

### ⚠️ Piper 没有(别踩坑)
- 没有 **quasiquote / 反引号**(`` ` `` `,` `,@`)——只有 `quote`(`'`);构造代码用 `list`/`cons`。
- 没有 **`case`**——用 `cond`。　没有 **`do`**——用具名 `let` 或 `loop`。
- 没有可变向量 / hash 字面量 / 字符串原地修改——以列表为主。

---

## 三个完整小例

```scheme
;; 1. 多模型合议:fan-out 一组 model,标准字符串直接当 score
(best (map model (list "deepseek-v4-pro" "kimi2.6" "deepseek-v4-flash"))
      "用一句话解释尾递归"
      "准确且简洁")

;; 2. 回溯搜索:认知提候选 → 执行做 → 真实验证 → 不行回溯
;;    (idea 是 amb* 当前选中的候选思路;失败 require 触发回溯换下一个)
(define idea (amb* (propose 4 "修复 slugify 的不同思路")))
(agent "sandbox" (fmt "按这个思路实现:{}" idea))
(require (shell-ok? "cd sandbox && python3 -m pytest -q"))
idea

;; 3. 参考本地代码再提方案(边界规则)
(propose 3 (fmt "给出修复以下代码的 3 个思路:\n{}"
                (read-files (list "sandbox/solution.py"))))
```

完整原语清单见 `src/primitives.rkt`;设计与定位见 `docs/DESIGN.md`;可跑示例见 `examples/`。
