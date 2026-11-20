import { createApp } from './app.ts';
const port = Number(process.env.FORGE_PORT ?? 8091);
createApp().listen(port, () => console.log(`forge on ${port}`));
