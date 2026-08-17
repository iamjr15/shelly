type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 364 411"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M0 49 7 35 21 33l132 55 22 5 9-12V10l6-8 10-2 160 65 4 6v87l-5 6h-18l-129-54-22-5-7 10v65l7 21 10 11 155 63 8 7v91l-8 6h-9l-143-59-11-1-9 9-1 74-6 8-15 1L7 347l-7-14v-71l7-14 13-2 139 58 17 2 8-12-1-65-8-19-12-12L4 131l-4-11Z"
        fill="currentColor"
      />
    </svg>
  );
}
