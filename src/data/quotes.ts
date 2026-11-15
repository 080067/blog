export type QuoteCategory = "daily" | "study" | "healing" | "dream";

export interface QuoteItem {
	text: string;
	category: QuoteCategory;
	label: string;
}

// 主页的语录集中放在这里，后续只需要继续添加对象即可同步到各个语录组件。
export const quoteItems: QuoteItem[] = [
	{ text: "虚无不是终点，它只是提醒我：意义要自己写。", category: "daily", label: "随笔" },
	{ text: "夜晚很长，足够把一个想法慢慢写成代码。", category: "study", label: "软件" },
	{ text: "在故事与音乐里，短暂地借用另一种人生。", category: "dream", label: "ACG" },
	{ text: "不必急着给生活答案，先把今天过完。", category: "healing", label: "日常" },
	{ text: "愿每一次保存，都是给未来自己的小小回信。", category: "dream", label: "记录" },
];
