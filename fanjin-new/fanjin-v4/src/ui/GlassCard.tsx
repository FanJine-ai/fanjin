import React from "react";
import { V4 } from "./tokens";

interface GlassCardProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  onClick?: () => void;
  hoverable?: boolean;
}

const baseStyle: React.CSSProperties = {
  background: V4.glass.background,
  backdropFilter: V4.glass.backdropFilter as any,
  WebkitBackdropFilter: (V4.glass as any).WebkitBackdropFilter,
  border: V4.glass.border,
  boxShadow: V4.glass.boxShadow,
  borderRadius: V4.glass.borderRadius,
  transition: "background 0.2s ease",
};

const hoverStyle: React.CSSProperties = {
  background: V4.bgPanelHover,
};

const GlassCard: React.FC<GlassCardProps> = ({
  children,
  style,
  onClick,
  hoverable = false,
}) => {
  const [hovered, setHovered] = React.useState(false);

  return (
    <div
      style={{
        ...baseStyle,
        ...(hoverable && hovered ? hoverStyle : {}),
        ...(onClick ? { cursor: "pointer" } : {}),
        ...style,
      }}
      onClick={onClick}
      onMouseEnter={hoverable ? () => setHovered(true) : undefined}
      onMouseLeave={hoverable ? () => setHovered(false) : undefined}
    >
      {children}
    </div>
  );
};

export default React.memo(GlassCard);
