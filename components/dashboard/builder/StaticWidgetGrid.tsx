"use client";

// Plain CSS-grid positioning for a dashboard's widgets -- used by the view
// page and the Code editor's preview pane. Deliberately has no
// react-grid-layout dependency (that's CanvasEditor.tsx's job, and only
// there) so normal dashboard viewing never loads it. Row height (40px) and
// column count (12) match CanvasEditor's own <GridLayout cols={12} rowHeight={40}>
// so switching between the interactive canvas and this static view doesn't
// visibly reflow.
// Below 768px (see StaticWidgetGrid.module.css) every widget collapses to
// one full-width column in y-order instead of keeping its designed x/y/w/h
// -- a widget's `h` was tuned for its wide layout, so a real screen-width
// media query (not just a narrower 12-col grid) is what keeps e.g. a grid
// widget's table or a multi-field form from being squeezed unreadably thin.
import type { DashboardWidget } from "@/lib/dashboardWidgets/types";
import styles from "./StaticWidgetGrid.module.css";

interface Props {
  widgets: DashboardWidget[];
  children: (widget: DashboardWidget) => React.ReactNode;
}

export default function StaticWidgetGrid({ widgets, children }: Props) {
  if (widgets.length === 0) {
    return <p className="text-center text-[11px] text-slate-300 italic py-12">This dashboard has no widgets yet</p>;
  }

  return (
    <div className={styles.grid}>
      {widgets.map(w => (
        <div
          key={w.id}
          className={styles.item}
          style={{
            '--col-start': w.layout.x + 1,
            '--col-span': w.layout.w,
            '--row-start': w.layout.y + 1,
            '--row-span': w.layout.h,
          } as React.CSSProperties}
        >
          {children(w)}
        </div>
      ))}
    </div>
  );
}
