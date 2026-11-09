import { useState } from "react";
import { useV4Theme } from "../../ui/useV4Theme";
import FrontstageNav from "../frontstage/FrontstageNav";
import ProjectGallery from "./ProjectGallery";
import "../assets/AssetListPage.css";

type ProjectListPageProps = {
  canvasEntry?: boolean;
};

export default function ProjectListPage({ canvasEntry = false }: ProjectListPageProps) {
  const theme = useV4Theme();
  const dark = theme.mode === "dark";
  const [notice, setNotice] = useState("");

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 2400);
  }

  return (
    <main className={`assetFrontPage ${dark ? "themeDark" : "themeLight"}`}>
      <section className="assetFrontShell">
        <FrontstageNav active={canvasEntry ? "canvas" : "projects"} dark={dark} onToggleDark={theme.toggle} onNotice={showNotice} />
        <div className="assetFrontMain">
          <ProjectGallery galleryOnly={!canvasEntry} themeMode={theme.mode} />
        </div>
      </section>
      {notice ? <div className="jimengToast">{notice}</div> : null}
    </main>
  );
}
