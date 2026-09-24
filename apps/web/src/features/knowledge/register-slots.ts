import { MY_WORK_SECTIONS } from '@/lib/slots';
import { MyReadingSection } from './my-reading-section';

MY_WORK_SECTIONS.register({ key: 'required-reading', label: 'Required Reading', order: 60, visible: (_p, can) => can('knowledge.read'), component: MyReadingSection });
