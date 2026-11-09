import {
  useId,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  Image as ImageIcon,
  Layers3,
  PackageOpen,
  Palette,
  Wrench,
} from "lucide-react";
import "./ProjectStudioShell.css";

export type StudioContextAsset = {
  id: string | number;
  name: string;
  thumbnailUrl?: string | null;
  kind?: string;
  assetId?: number;
  assetVersionId?: string | null;
};

export type StudioContextSkill = {
  id: string | number;
  name: string;
  source?: string;
};

export type StudioContextStyle = {
  id: string | number;
  name: string;
  source?: string;
};

export type StudioContextReference = {
  id: string | number;
  name: string;
  thumbnailUrl?: string | null;
  kind?: string;
  assetId?: number;
  assetVersionId?: string;
};

export type ContextPanelState = {
  expanded: boolean;
};

export type ContextPanelAction =
  | { type: "toggle" }
  | { type: "set"; expanded: boolean };

export function reduceContextPanel(
  state: ContextPanelState,
  action: ContextPanelAction,
): ContextPanelState {
  if (action.type === "toggle") return { expanded: !state.expanded };
  return action.expanded === state.expanded ? state : { expanded: action.expanded };
}

export type ContextPanelProps = {
  /** Context proven consumed by a successful server-side model response. */
  usedAssets?: readonly StudioContextAsset[];
  usedSkills?: readonly StudioContextSkill[];
  usedStyles?: readonly StudioContextStyle[];
  usedReferences?: readonly StudioContextReference[];
  /** Context confirmed by the server for an earlier turn; this does not imply model consumption. */
  assets?: readonly StudioContextAsset[];
  skills?: readonly StudioContextSkill[];
  styles?: readonly StudioContextStyle[];
  references?: readonly StudioContextReference[];
  /** Context selected for the next turn but not yet accepted by the Runtime. */
  pendingAssets?: readonly StudioContextAsset[];
  pendingSkills?: readonly StudioContextSkill[];
  pendingStyles?: readonly StudioContextStyle[];
  pendingReferences?: readonly StudioContextReference[];
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onAssetSelect?: (asset: StudioContextAsset) => void;
  onSkillSelect?: (skill: StudioContextSkill) => void;
  onStyleSelect?: (style: StudioContextStyle) => void;
  onReferenceSelect?: (reference: StudioContextReference) => void;
  title?: string;
  description?: string;
  footer?: ReactNode;
  className?: string;
};

function Thumbnail({ asset }: { asset: StudioContextAsset | StudioContextReference }) {
  const thumbnailUrl = asset.thumbnailUrl?.trim() || "";
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!thumbnailUrl || failedUrl === thumbnailUrl) {
    return (
      <span className="projectStudioContextAssetFallback" aria-hidden="true">
        <ImageIcon size={17} />
      </span>
    );
  }
  return (
    <img
      src={thumbnailUrl}
      alt=""
      loading="lazy"
      onError={() => setFailedUrl(thumbnailUrl)}
      onLoad={() => setFailedUrl(null)}
    />
  );
}

function ContextItem({
  children,
  onClick,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  ariaLabel: string;
}) {
  if (onClick) {
    return (
      <button type="button" aria-label={ariaLabel} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <div>{children}</div>;
}

type ContextScope = "used" | "confirmed" | "pending";

function displayKind(kind: string | undefined, scopeId: ContextScope) {
  return kind?.trim() || (scopeId === "used" ? "已使用" : scopeId === "confirmed" ? "已确认" : "待携带");
}

function contextItemKey(scopeId: ContextScope, category: string, id: string | number) {
  return `${scopeId}:${category}:${typeof id}:${String(id)}`;
}

type ContextSectionsProps = {
  panelId: string;
  scopeId: ContextScope;
  scopeLabel: string;
  assets: readonly StudioContextAsset[];
  skills: readonly StudioContextSkill[];
  styles: readonly StudioContextStyle[];
  references: readonly StudioContextReference[];
  onAssetSelect?: (asset: StudioContextAsset) => void;
  onSkillSelect?: (skill: StudioContextSkill) => void;
  onStyleSelect?: (style: StudioContextStyle) => void;
  onReferenceSelect?: (reference: StudioContextReference) => void;
};

function ContextSections({
  panelId,
  scopeId,
  scopeLabel,
  assets,
  skills,
  styles,
  references,
  onAssetSelect,
  onSkillSelect,
  onStyleSelect,
  onReferenceSelect,
}: ContextSectionsProps) {
  return (
    <>
      {assets.length ? (
        <section className="projectStudioContextSection" aria-labelledby={`${panelId}-${scopeId}-assets`}>
          <header>
            <span id={`${panelId}-${scopeId}-assets`}>{scopeLabel} · 资产</span>
            <small>{assets.length}</small>
          </header>
          <div className="projectStudioContextAssets">
            {assets.map((asset) => (
              <ContextItem
                ariaLabel={`查看资产 ${asset.name}`}
                key={contextItemKey(scopeId, "asset", asset.id)}
                onClick={onAssetSelect ? () => onAssetSelect(asset) : undefined}
              >
                <span className="projectStudioContextAssetImage">
                  <Thumbnail asset={asset} />
                </span>
                <span className="projectStudioContextItemCopy">
                  <strong>{asset.name}</strong>
                  <small>{displayKind(asset.kind, scopeId)}</small>
                </span>
              </ContextItem>
            ))}
          </div>
        </section>
      ) : null}

      {skills.length ? (
        <section className="projectStudioContextSection" aria-labelledby={`${panelId}-${scopeId}-skills`}>
          <header>
            <span id={`${panelId}-${scopeId}-skills`}>{scopeLabel} · 技能</span>
            <small>{skills.length}</small>
          </header>
          <div className="projectStudioContextChips">
            {skills.map((skill) => (
              <ContextItem
                ariaLabel={`查看技能 ${skill.name}`}
                key={contextItemKey(scopeId, "skill", skill.id)}
                onClick={onSkillSelect ? () => onSkillSelect(skill) : undefined}
              >
                <Wrench size={13} aria-hidden="true" />
                <span>{skill.name}</span>
                {skill.source ? <small>{skill.source}</small> : null}
              </ContextItem>
            ))}
          </div>
        </section>
      ) : null}

      {styles.length ? (
        <section className="projectStudioContextSection" aria-labelledby={`${panelId}-${scopeId}-styles`}>
          <header>
            <span id={`${panelId}-${scopeId}-styles`}>{scopeLabel} · 风格</span>
            <small>{styles.length}</small>
          </header>
          <div className="projectStudioContextChips">
            {styles.map((style) => (
              <ContextItem
                ariaLabel={`查看风格 ${style.name}`}
                key={contextItemKey(scopeId, "style", style.id)}
                onClick={onStyleSelect ? () => onStyleSelect(style) : undefined}
              >
                <Palette size={13} aria-hidden="true" />
                <span>{style.name}</span>
                {style.source ? <small>{style.source}</small> : null}
              </ContextItem>
            ))}
          </div>
        </section>
      ) : null}

      {references.length ? (
        <section className="projectStudioContextSection" aria-labelledby={`${panelId}-${scopeId}-references`}>
          <header>
            <span id={`${panelId}-${scopeId}-references`}>{scopeLabel} · 参考</span>
            <small>{references.length}</small>
          </header>
          <div className="projectStudioContextAssets">
            {references.map((reference) => (
              <ContextItem
                ariaLabel={`查看参考 ${reference.name}`}
                key={contextItemKey(scopeId, "reference", reference.id)}
                onClick={onReferenceSelect ? () => onReferenceSelect(reference) : undefined}
              >
                <span className="projectStudioContextAssetImage">
                  <Thumbnail asset={reference} />
                </span>
                <span className="projectStudioContextItemCopy">
                  <strong>{reference.name}</strong>
                  <small>{displayKind(reference.kind, scopeId)}</small>
                </span>
              </ContextItem>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

export function ContextPanel({
  usedAssets = [],
  usedSkills = [],
  usedStyles = [],
  usedReferences = [],
  assets = [],
  skills = [],
  styles = [],
  references = [],
  pendingAssets = [],
  pendingSkills = [],
  pendingStyles = [],
  pendingReferences = [],
  expanded: controlledExpanded,
  defaultExpanded = false,
  onExpandedChange,
  onAssetSelect,
  onSkillSelect,
  onStyleSelect,
  onReferenceSelect,
  title = "上下文",
  description = "模型已使用、服务端已确认与本轮待提交内容",
  footer,
  className,
}: ContextPanelProps) {
  const [panelState, dispatch] = useReducer(reduceContextPanel, {
    expanded: defaultExpanded,
  });
  const expanded = controlledExpanded ?? panelState.expanded;
  const panelId = useId();
  const usedCount = usedAssets.length + usedSkills.length + usedStyles.length + usedReferences.length;
  const confirmedCount = assets.length + skills.length + styles.length + references.length;
  const pendingCount = pendingAssets.length + pendingSkills.length + pendingStyles.length + pendingReferences.length;
  const totalCount = usedCount + confirmedCount + pendingCount;

  function setExpanded(nextExpanded: boolean) {
    if (controlledExpanded === undefined) {
      dispatch({ type: "set", expanded: nextExpanded });
    }
    onExpandedChange?.(nextExpanded);
  }

  return (
    <section
      className={["projectStudioContextPanel", className].filter(Boolean).join(" ")}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        className="projectStudioContextHeader"
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="projectStudioContextHeadingIcon" aria-hidden="true">
          <Layers3 size={16} />
        </span>
        <span className="projectStudioContextHeadingCopy">
          <strong>{title}</strong>
          <small>{expanded ? description : `${usedCount} 项已使用 · ${confirmedCount} 项已确认 · ${pendingCount} 项待携带`}</small>
        </span>
        <span className="projectStudioContextCount" aria-label={`${totalCount} 项`}>
          {totalCount}
        </span>
        <ChevronDown className="projectStudioContextChevron" size={16} aria-hidden="true" />
      </button>

      <div className="projectStudioContextBody" id={panelId} hidden={!expanded}>
        {totalCount === 0 ? (
          <div className="projectStudioContextEmpty">
            <PackageOpen size={19} aria-hidden="true" />
            <span>当前没有已使用、已确认或待提交的上下文</span>
          </div>
        ) : null}

        <ContextSections
          panelId={panelId}
          scopeId="used"
          scopeLabel="上文已使用"
          assets={usedAssets}
          skills={usedSkills}
          styles={usedStyles}
          references={usedReferences}
          onAssetSelect={onAssetSelect}
          onSkillSelect={onSkillSelect}
          onStyleSelect={onStyleSelect}
          onReferenceSelect={onReferenceSelect}
        />
        <ContextSections
          panelId={panelId}
          scopeId="confirmed"
          scopeLabel="上文已确认"
          assets={assets}
          skills={skills}
          styles={styles}
          references={references}
          onAssetSelect={onAssetSelect}
          onSkillSelect={onSkillSelect}
          onStyleSelect={onStyleSelect}
          onReferenceSelect={onReferenceSelect}
        />
        <ContextSections
          panelId={panelId}
          scopeId="pending"
          scopeLabel="本轮待携带"
          assets={pendingAssets}
          skills={pendingSkills}
          styles={pendingStyles}
          references={pendingReferences}
          onAssetSelect={onAssetSelect}
          onSkillSelect={onSkillSelect}
          onStyleSelect={onStyleSelect}
          onReferenceSelect={onReferenceSelect}
        />

        {footer ? <footer className="projectStudioContextFooter">{footer}</footer> : null}
      </div>
    </section>
  );
}

export default ContextPanel;
