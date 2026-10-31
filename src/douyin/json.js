// 抖音返回体的 JSON 解析。它的 Playwright 环境里（页内 fetch 的 text）
// 偶尔会把大整数/特殊字符弄坏，所以这里做"能修就修"的宽松解析。

/** 严格解析失败时，尝试修补常见问题（截断的尾部、未转义控制字符） */
export function lenientJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试修复 */
  }
  // 1) 去掉 BOM / 前后杂质
  const start = s.indexOf('{') >= 0 ? s.indexOf('{') : s.indexOf('[');
  if (start > 0) {
    try {
      return JSON.parse(s.slice(start));
    } catch {
      /* ignore */
    }
  }
  // 2) 去掉非法控制字符后再试
  try {
    // eslint-disable-next-line no-control-regex
    return JSON.parse(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
  } catch {
    /* ignore */
  }
  // 3) 被截断的 JSON：从尾部回退到最后一个完整的 } 或 ]
  for (let i = s.length - 1; i > Math.max(0, s.length - 5000); i--) {
    const ch = s[i];
    if (ch === '}' || ch === ']') {
      const candidate = s.slice(0, i + 1);
      // 补齐括号
      const fixed = balanceBrackets(candidate);
      try {
        return JSON.parse(fixed);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function balanceBrackets(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}
