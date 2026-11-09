import { useNavigate } from "react-router-dom";
import { useV4Theme } from "../../ui/useV4Theme";
import "../frontstage/FrontstagePage.css";

export default function NotFound() {
  const navigate = useNavigate();
  const theme = useV4Theme();
  return (
    <main className="frontPagePalette frontErrorPage" data-theme={theme.mode}>
      <section className="frontErrorPanel">
        <strong>404</strong>
        <h1>页面不存在</h1>
        <p>这个地址可能已被移动或删除，你可以返回首页继续创作。</p>
        <button type="button" onClick={() => navigate("/")}>返回首页</button>
      </section>
    </main>
  );
}
