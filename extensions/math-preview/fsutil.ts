/**
 * 输出目录的文件管理（独立模块，便于脱离 pi 单独测试）
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** 页面文件命名：<会话id前8位或 unknown>-<yyyyMMdd-HHmmss>[-序号].html */
export const PAGE_RE = /^[0-9a-zA-Z]{1,16}-\d{8}-\d{6}(?:-\d+)?\.html$/;

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 只保留最近 keep 个页面。
 * 文件名内嵌可排序时间戳，因此直接按文件名排序即可确定新旧，
 * 只在触发时执行一次 readdir（不 stat、不轮询）。
 */
export async function cleanupPages(dir: string, keep: number, re: RegExp = PAGE_RE): Promise<{ removed: number; kept: number }> {
	if (!(await exists(dir))) return { removed: 0, kept: 0 };
	const pages = (await readdir(dir)).filter((n) => re.test(n)).sort();
	if (pages.length <= keep) return { removed: 0, kept: pages.length };
	const doomed = pages.slice(0, pages.length - keep);
	let removed = 0;
	for (const name of doomed) {
		try {
			await unlink(join(dir, name));
			removed++;
		} catch {
			// 单个删除失败不影响整体
		}
	}
	return { removed, kept: pages.length - removed };
}
