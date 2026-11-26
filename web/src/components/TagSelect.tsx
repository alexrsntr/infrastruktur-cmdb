import { Select, type SelectProps } from 'antd';
import { normalizeTags } from '../../../shared/model';
import { useTags } from '../lib/queries';

type TagOption = { value: string; label: string; count: number };

function useTagOptions() {
  const tags = useTags();
  const options: TagOption[] = (tags.data ?? []).map((t) => ({ value: t.tag, label: t.tag, count: t.count }));
  return { options, known: options.map((o) => o.value), loading: tags.isLoading };
}

const renderOption: SelectProps['optionRender'] = (o) => (
  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
    <span className="muted">{(o.data as TagOption).count}</span>
  </span>
);

/** Tag input for forms: suggests the tags in use and keeps their spelling ("server" becomes "Server"). */
export function TagSelect({ value, onChange, placeholder = 'Pick or type tags' }: { value?: string[]; onChange?: (v: string[]) => void; placeholder?: string }) {
  const { options, known, loading } = useTagOptions();
  return (
    <Select<string[], TagOption>
      mode="tags"
      tokenSeparators={[',', ';']}
      placeholder={placeholder}
      value={value}
      onChange={(v) => onChange?.(normalizeTags(v, known))}
      options={options}
      optionRender={renderOption}
      loading={loading}
      allowClear
    />
  );
}

/** Filter by one tag (device lists). Hidden while no device has tags. */
export function TagFilter({ value, onChange, width = 180 }: { value?: string; onChange: (v: string | undefined) => void; width?: number }) {
  const { options, loading } = useTagOptions();
  if (!options.length && !value) return null;
  return (
    <Select<string, TagOption>
      allowClear
      showSearch
      placeholder="Any tag"
      style={{ width }}
      value={value}
      onChange={(v) => onChange(v || undefined)}
      options={options}
      optionRender={renderOption}
      loading={loading}
    />
  );
}
