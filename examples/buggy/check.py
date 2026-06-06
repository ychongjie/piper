# 测试 runner:只在最后打印一个整数 = 通过的检查数(供 Piper 编排当真实反馈)。
import solution as s

def chk(f, exp):
    try:
        return f() == exp
    except Exception:
        return False

checks = [
    (lambda: s.add(2, 3), 5),
    (lambda: s.add(0, 0), 0),
    (lambda: s.is_even(4), True),
    (lambda: s.is_even(7), False),
    (lambda: s.reverse_str("abc"), "cba"),
    (lambda: s.factorial(5), 120),
    (lambda: s.factorial(0), 1),
]

print(sum(1 for f, e in checks if chk(f, e)))
