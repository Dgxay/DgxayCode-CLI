'use strict';

/**
 * 轻量参数解析：支持 --flag、--flag value、--flag=value、-abc 组合、-- 终止符。
 *
 * 每个命令声明自己的选项：{ name, alias, type: 'string'|'boolean'|'number'|'list', desc, values }
 */

function camel(name) {
  return String(name).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function parseArgs(argv, spec = [], parseOptions = {}) {
  const allowUnknown = Boolean(parseOptions.allowUnknown);
  const options = {};
  const positionals = [];
  const lookup = new Map();
  for (const item of spec) {
    lookup.set(`--${item.name}`, item);
    if (item.alias) {
      for (const alias of [].concat(item.alias)) lookup.set(alias.length === 1 ? `-${alias}` : alias, item);
    }
    if (item.type === 'list') options[camel(item.name)] = [];
  }

  const rest = argv.slice();
  while (rest.length) {
    const token = rest.shift();
    if (token === '--') {
      positionals.push(...rest);
      break;
    }
    // -h / -v 是约定俗成的通用开关；但命令自己声明了同名短选项时以命令为准
    const takesHelp = !lookup.has('-h');
    const takesVersion = !lookup.has('-v');
    if ((token === '-h' || token === '--help') && takesHelp) {
      options.help = true;
      continue;
    }
    if ((token === '-v' || token === '--version') && (takesVersion || token === '--version')) {
      options.version = true;
      continue;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const item = lookup.get(name);
      if (!item) {
        if (allowUnknown) {
          // 全局解析阶段：不认识的选项原样保留，交给子命令自己解析
          positionals.push(token);
          continue;
        }
        const error = new Error(`未知选项：${name}`);
        error.userError = true;
        throw error;
      }
      const key = camel(item.name);
      if (item.type === 'boolean') {
        options[key] = inline === undefined ? true : !/^(false|0|no)$/i.test(inline);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        value = rest.shift();
        if (value === undefined) {
          const error = new Error(`选项 ${name} 需要一个值`);
          error.userError = true;
          throw error;
        }
      }
      if (item.type === 'list') options[key] = options[key].concat([value]);
      else if (item.type === 'number') options[key] = Number(value);
      else options[key] = value;
      continue;
    }

    // 任意 -x / -abc 组合短选项（未知的仍然报错，避免把 -5 这类输入吞掉）
    if (/^-[A-Za-z]/.test(token)) {
      // 组合短选项：-abc，只有最后一位可以带值
      const chars = token.slice(1).split('');
      for (let i = 0; i < chars.length; i += 1) {
        const item = lookup.get(`-${chars[i]}`);
        if (!item) {
          if (allowUnknown) {
            positionals.push(token);
            break;
          }
          const error = new Error(`未知选项：-${chars[i]}`);
          error.userError = true;
          throw error;
        }
        const key = camel(item.name);
        if (item.type === 'boolean') {
          options[key] = true;
          continue;
        }
        const value = i === chars.length - 1 ? rest.shift() : chars.slice(i + 1).join('');
        if (value === undefined) {
          const error = new Error(`选项 -${chars[i]} 需要一个值`);
          error.userError = true;
          throw error;
        }
        if (item.type === 'list') options[key] = options[key].concat([value]);
        else if (item.type === 'number') options[key] = Number(value);
        else options[key] = value;
        break;
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/**
 * 多级子命令解析：第一个位置参数是动作名，剩余参数才按 spec 解析选项。
 * 返回 { action, rest, options, positionals }
 */
function actionFirst(argv, spec = []) {
  const list = argv.slice();
  const actionSpec = {};
  for (const item of Array.isArray(spec) ? spec : []) {
    if (item && item.name) actionSpec[item.name] = item;
  }
  const defaultAction = spec && spec.action && typeof spec.action === 'string' ? spec.action : '';
  const actionIndex = list.findIndex((token) => !token.startsWith('-'));
  const action = actionIndex === -1 ? defaultAction : list[actionIndex];
  if (actionIndex !== -1) list.splice(actionIndex, 1);
  const parsed = parseArgs(list, Object.values(actionSpec));
  return { action, rest: parsed.positionals, options: parsed.options, positionals: parsed.positionals };
}

/**
 * 简单选择器：把用户输入按名称或序号解析成列表中的一项。
 * 序号 1 表示第一项（与 /chat list 的输出保持一致）。
 */
function pick(list, ref, label = '项目') {
  if (!list.length) return null;
  if (!ref) return list[0];
  const text = String(ref).trim();
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= list.length) return list[index - 1];
  const exact = list.find((item) => item.id === text || String(item.name || '').toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  const partial = list.filter(
    (item) => String(item.id).startsWith(text) || String(item.name || '').toLowerCase().startsWith(text.toLowerCase())
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const error = new Error(`${label}名称不唯一：「${text}」匹配到 ${partial.length} 项`);
    error.userError = true;
    throw error;
  }
  return null;
}

module.exports = { parseArgs, actionFirst, pick, camel };
