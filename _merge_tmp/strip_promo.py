import json
import re
from pathlib import Path

BACKSLASH = chr(92)

for name in ["en", "zh", "zh-TW", "ja"]:
    p = Path(f"src/i18n/locales/{name}.json")
    t = p.read_text(encoding="utf-8")
    key = '"partnerPromotion": {'
    if key not in t:
        print(f"{name}: no partnerPromotion")
        continue
    start = t.index(key)
    line_start = t.rindex("\n", 0, start) + 1
    brace = t.index("{", start)
    depth = 0
    i = brace
    in_str = False
    esc = False
    while i < len(t):
        c = t[i]
        if in_str:
            if esc:
                esc = False
            elif c == BACKSLASH:
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    end = i + 1
    rest = t[end:]
    m = re.match(r",?\s*\n", rest)
    consume = m.end() if m else 0
    t2 = t[:line_start] + t[end + consume :]
    p.write_text(t2, encoding="utf-8")
    try:
        json.loads(t2)
        print(f"{name}: removed partnerPromotion, JSON valid")
    except Exception as e:
        print(f"{name}: JSON INVALID -> {e}")
