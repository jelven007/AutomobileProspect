import { useRef, type ThHTMLAttributes } from 'react';

interface Props extends ThHTMLAttributes<HTMLTableCellElement> {
  resizeLabel?: string;
  columnWidth?: number;
  onColumnResize?: (width: number) => void;
  onColumnReset?: () => void;
}

export function ResizableHeader({
  resizeLabel, columnWidth, onColumnResize, onColumnReset, children, ...props
}: Props) {
  const drag = useRef<{ startX: number; width: number }>();
  return (
    <th {...props}>
      {children}
      {onColumnResize && columnWidth !== undefined && (
        <span
          className="column-resize-handle"
          role="separator"
          aria-label={`调整${resizeLabel}列宽`}
          aria-orientation="vertical"
          aria-valuenow={columnWidth}
          aria-valuemin={56}
          aria-valuemax={640}
          tabIndex={0}
          title="拖动调整列宽，双击恢复；方向键微调"
          onDoubleClick={onColumnReset}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              onColumnResize(Math.max(56, Math.min(640, columnWidth + (event.key === 'ArrowRight' ? 16 : -16))));
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            drag.current = { startX: event.clientX, width: columnWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            onColumnResize(Math.max(56, Math.min(640, drag.current.width + event.clientX - drag.current.startX)));
          }}
          onPointerUp={() => { drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}
          onLostPointerCapture={() => { drag.current = undefined; }}
        />
      )}
    </th>
  );
}
