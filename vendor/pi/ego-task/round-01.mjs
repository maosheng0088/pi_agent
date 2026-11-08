const task = await taskSpace("open baidu");
const page = task.page("p1");
await page.goto("https://www.baidu.com");
await page.waitForLoadState();
console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log({ url: await page.url(), title: await page.title() });
console.log(await page.snapshot());
