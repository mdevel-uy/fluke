interface ColumnEmptyProps {
  message: string;
}

export function ColumnEmpty({ message }: ColumnEmptyProps) {
  return (
    <div className="flex items-center justify-center text-center px-4 py-8 rounded-xl border border-dashed border-border/60 bg-primary/40">
      <p className="text-xs text-low leading-relaxed">{message}</p>
    </div>
  );
}
