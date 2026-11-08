import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { DATE_FORMAT } from '../lib/format';

/** Date picker for values stored as "YYYY-MM-DD" strings (e.g. date fields of an asset type). */
export function DateStringInput({ value, onChange }: { value?: string | null; onChange?: (value: string | null) => void }) {
  const parsed = value ? dayjs(value) : null;
  return (
    <DatePicker
      format={DATE_FORMAT}
      style={{ width: '100%' }}
      value={parsed?.isValid() ? parsed : null}
      onChange={(d) => onChange?.(d ? d.format('YYYY-MM-DD') : null)}
    />
  );
}
