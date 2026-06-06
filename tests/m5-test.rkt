#lang racket/base

;; M5 测试:loop —— 周期/条件/自定步重入。控制逻辑确定,大多无需网络;
;; LLM 自定步那条用 mock。运行:raco test tests/m5-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

(define (E s) (eval-string s (make-interpreter)))

;; ---- times:重复 n 次 ----
(check-equal? (E "(define n 0) (loop (times 5) (set! n (add1 n))) n") 5)
(check-equal? (E "(loop (times 3) 'x)") 'x)             ; 返回最后一次 body 值
(check-equal? (E "(define n 0) (loop (times 0) (set! n 99)) n") 0)  ; 0 次不执行

;; ---- until:重复直到谓词为真(每轮前检查)----
(check-equal? (E "(define n 0) (loop (until (>= n 5)) (set! n (add1 n))) n") 5)
(check-equal? (E "(define n 0) (loop (until (> n 0)) (set! n 1)) n") 1)
;; 谓词一开始就为真 -> body 不执行
(check-equal? (E "(define n 7) (loop (until (= n 7)) (set! n 0)) n") 7)

;; ---- break:用 call/cc 提前中断,返回 break 的值 ----
(check-equal?
 (E "(define n 0)
     (loop (times 100) (set! n (add1 n)) (if (= n 3) (break 'stopped) #f))")
 'stopped)
(check-equal?
 (E "(define n 0)
     (loop (times 100) (set! n (add1 n)) (if (= n 3) (break n) #f))")
 3)

;; ---- every:周期模式(secs=0 不真睡,仅验证执行路径)----
(check-equal?
 (E "(define n 0) (loop (until (>= n 4) every 0) (set! n (add1 n))) n")
 4)

;; ---- self-paced:body 返回指令决定调度 ----
(check-equal?
 (E "(define n 0)
     (loop (self-paced)
       (set! n (add1 n))
       (if (>= n 4) (list 'stop n) (list 'continue)))")
 4)
;; 含 delay 分支(secs=0)
(check-equal?
 (E "(define n 0)
     (loop (self-paced)
       (set! n (add1 n))
       (cond ((= n 1) (list 'delay 0))
             ((>= n 3) (list 'stop n))
             (else (list 'continue))))")
 3)

;; ---- self-paced 由 LLM 决定调度(mock)----
;; body 调 llm-code 取下一步指令(直接 read 成数据,无需 eval);
;; mock 脚本化返回 (continue)/(continue)/(stop 42)
(let ([mock (let ([steps (list "(continue)" "(continue)" "(stop 42)")])
              (lambda (p s m)
                (let ([x (car steps)]) (set! steps (cdr steps)) x)))])
  (check-equal?
   (parameterize ([current-llm mock])
     (eval-string "(loop (self-paced) (llm-code \"下一步?\"))"
                  (make-interpreter)))
   42))

;; ---- L2 driver 也可直接调用(不经宏)----
(check-equal?
 (E "(define n 0) (loop-times 4 (lambda (break) (set! n (add1 n)))) n")
 4)
