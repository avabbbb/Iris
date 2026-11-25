/**
 * 「给 Iris 点个 Star」提示（网页端）。只在一个自然的时刻出现一次：本次会话里插件刚配对成功、
 * 网关请求改为直连之后。关闭或点过之后永久记住（localStorage），不会再出现。
 */
export const IRIS_GITHUB_URL = 'https://github.com/avabbbb/Iris';
export const STAR_PROMPT_KEY = 'iris.starPrompt.dismissed';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function isStarPromptDismissed(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(STAR_PROMPT_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissStarPrompt(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(STAR_PROMPT_KEY, '1');
  } catch {
    // storage unavailable: hidden for this render only
  }
}

/** 本次会话里插件从「未直连」变为「可直连」：这是用户刚完成配对的那一刻。 */
export function becameDirectCapable(previous: boolean | null, current: boolean): boolean {
  return previous === false && current;
}
