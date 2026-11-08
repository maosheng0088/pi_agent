const task = await taskSpace("open baidu");
const page = task.page("p1");
const path = await page.screenshot({ path: "D:/code/pi/ego-task/baidu-home.png" });
console.log({ path, url: await page.url(), title: await page.title() });
