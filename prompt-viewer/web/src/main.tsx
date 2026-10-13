import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SkillFilePage } from "./components/SkillFilePage";
import { parseSkillRoute } from "./routes";
import "./index.css";

/**
 * 极简 hash 路由：`#/skill/:name` 渲染技能文件页，其余渲染日志查看器。
 * 分支在挂载前完成，故新标签页打开技能文件时不会去拉日志列表。
 */
function Root() {
  const [route, setRoute] = useState(() => parseSkillRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseSkillRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route ? (
    <SkillFilePage key={route.name} name={route.name} initialRel={route.rel} />
  ) : (
    <App />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
