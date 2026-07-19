interface ColumnEmptyProps {
  message: string;
}

export function ColumnEmpty({ message }: ColumnEmptyProps) {
  return (
    <p className="text-xs text-low italic px-half py-base text-center">
      {message}
    </p>
  );
}
