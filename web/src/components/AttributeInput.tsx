import { Input, InputNumber, Select, Switch } from 'antd';
import type { FieldDef } from '../../../shared/model';
import { DateStringInput } from './DateStringInput';

/** What Form.Item hands to its control – has to reach the inner input, otherwise the form never sees the value */
interface ControlProps {
  id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
  checked?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: (...args: any[]) => void;
}

/** Input for a field of a device type (built-in or added under Settings → Device types). */
export function AttributeInput({ field, options, ...control }: { field: FieldDef; options?: string[] } & ControlProps) {
  switch (field.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} addonAfter={field.unit} {...control} />;
    case 'boolean':
      return <Switch {...control} />;
    case 'select':
      return <Select allowClear options={(options ?? field.options)?.map((o) => ({ value: o, label: o }))} {...control} />;
    case 'date':
      return <DateStringInput value={control.value} onChange={control.onChange} />;
    default:
      return <Input placeholder={field.placeholder} {...control} />;
  }
}
