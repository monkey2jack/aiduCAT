// f03p-fix-#8: the long-answer samples (production 10:14: a 17,451-char answer
// overflowed the card and was re-sent as unformatted plain text).

/** ~17,451 Chinese chars in paragraphs, each tagged 〔P<n>〕, plus an image and HTML. */
export function longChinese(target = 17_451): string {
  const out: string[] = ['# 长回答', '开头有一张图 ![图](https://ex.com/a.png) 和 <b>粗体</b>。'];
  let n = 0;
  let len = out.join('\n\n').length;
  while (len < target) {
    n++;
    const p =
      n % 12 === 0
        ? `## 第 ${n / 12} 节 〔P${n}〕`
        : `〔P${n}〕这是第${n}段，讲清楚一件事：先说结论，再说理由，最后给出步骤。`.repeat(3);
    out.push(p);
    len += p.length + 2;
  }
  return out.join('\n\n');
}

/** Prose + one ~70KB fenced code block (2,500 numbered lines) + prose. */
export function longCode(lines = 2_500): string {
  const body = Array.from({ length: lines }, (_, i) => `const v${i} = "line ${i}"; // 第${i}行`).join('\n');
  return `下面是完整代码：\n\n\`\`\`ts\n${body}\n\`\`\`\n\n代码结束，说明见上。`;
}

/** 8 tables × 80 rows with headings between, then one 400-row table bigger than a card. */
export function manyTables(tables = 8, rows = 80, bigRows = 400): string {
  const out: string[] = ['# 对比表'];
  for (let t = 0; t < tables; t++) {
    out.push(`## 表 ${t}`);
    const lines = ['| 编号 | 值 | 说明 |', '|---|---|---|'];
    for (let i = 0; i < rows; i++) lines.push(`| r${t}-${i} | 值${i} | 这一行是表格 ${t} 的第 ${i} 行，说明文字略长一些 |`);
    out.push(lines.join('\n'));
  }
  out.push(`## 大表`);
  const big = ['| 编号 | 值 | 说明 |', '|---|---|---|'];
  for (let i = 0; i < bigRows; i++) big.push(`| r${tables}-${i} | 值${i} | 这一行是大表的第 ${i} 行，说明文字略长一些 |`);
  out.push(big.join('\n'));
  return out.join('\n\n');
}
