#lang racket/base

;; Piper 入口:
;;   racket main.rkt            启动 REPL
;;   racket main.rkt file.piper 运行一个 Piper 程序

(require "src/interp.rkt")

(define (repl env)
  (display "piper> ")
  (flush-output)
  (define form (read))
  (unless (eof-object? form)
    (with-handlers ([exn:fail? (lambda (e) (printf "error: ~a\n" (exn-message e)))])
      (define v (peval form env))
      (unless (void? v) (write v) (newline)))
    (repl env)))

(module+ main
  (define args (current-command-line-arguments))
  (define env (make-interpreter))
  (cond
    [(zero? (vector-length args)) (repl env)]
    [else (eval-file (vector-ref args 0) env)]))
