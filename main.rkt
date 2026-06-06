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
  ;; 行缓冲:输出重定向到文件/管道时也能实时看到进展(默认是块缓冲)
  (when (file-stream-port? (current-output-port))
    (file-stream-buffer-mode (current-output-port) 'line))
  (define args (current-command-line-arguments))
  (define env (make-interpreter))
  (cond
    [(zero? (vector-length args)) (repl env)]
    [else (eval-file (vector-ref args 0) env)]))
