# Mobile QA Baseline

Codex Remote Bridge App 的主要使用场景是手机。任何涉及 `public/index.html`、Android 布局或移动端样式的改动，在交付前都必须按以下基准验收。

## Reference viewport

- Device: iPhone 15 Pro
- Viewport: 393 x 852 CSS pixels
- Zoom: 100%
- Orientation: portrait

桌面浏览器只用于调试，不作为移动端布局通过的依据。

## Required checks

1. 首屏没有横向滚动、裁切、文字溢出或控件重叠。
2. 顶部操作区在任务标题较长时仍可触达，且不会盖住标题或系统安全区。
3. 打开任务菜单、插件页和设置页后，列表可以滚动，底部输入框不会遮挡内容。
4. 输入框获得焦点和软键盘出现时，发送、停止和附件按钮仍然可见、可点击。
5. 中文和 English 切换后，顶部栏、任务标题、模型/推理标签和输入框不会错位。
6. Android 原生入口的扫码、手动连接和最近连接按钮在同一尺寸下完整可见。
7. 浏览器双指缩放未被页面禁用；放大后仍能滚动阅读并操作输入区。

## Delivery rule

每次移动端 UI 更新都要记录这个视口下的截图或等价浏览器验证结果；发现问题必须先修复移动端，再交付电脑端构建包。
