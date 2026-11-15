import type { ExpressiveCodeConfig, LicenseConfig, NavBarConfig, ProfileConfig, SiteConfig } from "./types/config";
import { LinkPreset } from "./types/config";

export const siteConfig: SiteConfig = {
	title: "39の寧靜之地",
	subtitle: "在虚无的缝隙里，留一盏安静的灯。",
	siteStartedAt: "2026-11-15",
	lang: "zh_CN",
	themeColor: { hue: 285, fixed: true },
	banner: {
		enable: true,
		// 不用图片背景了：改成一层纯 CSS 的柔和渐变（浅色粉蓝+淡紫，深色墨紫蓝）
		mode: "gradient",
		src: "/images/banner.jpeg",
		position: "center",
		credit: { enable: false, text: "", url: "" },
	},
	toc: { enable: true, depth: 2 },
	favicon: [
		{ src: "/images/favicon-rc-32.png", sizes: "32x32" },
		{ src: "/images/favicon-rc-180.png", sizes: "180x180" },
	],
};

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		{ name: "文章总览", url: "/archive/" },
		{ name: "日记", url: "/diary/" },
		{ name: "音乐", url: "/music/" },
		{ name: "作品集", url: "/works/" },
		{ name: "网盘", url: "/drive/" },
		{ name: "留言板", url: "/guestbook/" },
		{ name: "联系我", url: "/contact/" },
		LinkPreset.About,
	],
};

// Twikoo 服务会在部署阶段接入；留空不会影响其余页面。
export const twikooConfig = { envId: "" };

export const profileConfig: ProfileConfig = {
	avatar: "/images/avatar.jpg",
	name: "Shilin",
	bio: "一只深陷虚无主义的流浪汉。",
	links: [
		{ name: "GitHub", icon: "fa6-brands:github", url: "https://github.com/080067" },
		{ name: "Email", icon: "fa6-solid:envelope", url: "mailto:shilin2233na@gmail.com" },
		{ name: "QQ", icon: "fa6-brands:qq", url: "https://wpa.qq.com/msgrd?v=3&uin=2804249691&site=qq&menu=yes" },
	],
};

export const licenseConfig: LicenseConfig = {
	enable: true,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = { theme: "github-dark" };
