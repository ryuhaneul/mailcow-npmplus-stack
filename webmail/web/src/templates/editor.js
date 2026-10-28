import { templateUid } from './api.js';

export function templateEditorModel(template) {
  return template ? {
    id: template.id, owner: template.owner, ref: template.ref, name: template.name, subject: template.subject, html: template.html, shared: template.inShared,
    attachments: template.attachments.map(file => ({ ...file, templateRef: template.ref })),
  } : { name: '새 템플릿', subject: '', html: '<p><br></p>', shared: false, attachments: [] };
}
export function templateEditorStamp(model) {
  return JSON.stringify({ name: model.name, subject: model.subject, html: model.html, shared: model.shared, attachments: model.attachments.map(file => file.uploadId ? { uploadId: file.uploadId } : { templateRef: file.templateRef, part: file.part }) });
}
export function templateEditorDirty(model, baseline) { return Boolean(model && baseline !== templateEditorStamp(model)); }
export function templateEditorPayload(model) {
  const name = model.name.trim();
  if (!name || [...name].length > 100) throw { code: 'TEMPLATE_INVALID', message: '템플릿 이름은 1~100자로 입력해 주세요.' };
  return { name, subject: model.subject, html: model.html, shared: model.shared, attachments: model.attachments.map(file => file.uploadId ? { uploadId: file.uploadId } : { templateRef: file.templateRef, part: file.part }), ...(model.ref ? { baseUid: templateUid(model.ref) } : {}) };
}
export function templateEditorRemoveAttachment(model, index) {
  const file = model.attachments[index];
  let html = model.html;
  if (file?.templateRef) {
    const root = document.createElement('template'); root.innerHTML = html;
    const source = `/api/messages/${encodeURIComponent(file.templateRef)}/parts/${encodeURIComponent(file.part)}?inline=1`;
    for (const image of root.content.querySelectorAll('img[src]')) if (image.getAttribute('src') === source) image.remove();
    html = root.innerHTML;
  }
  return { ...model, html, attachments: model.attachments.filter((_, position) => position !== index) };
}
export const templateEditorConflict = error => ['TEMPLATE_CHANGED', 'STALE_REF'].includes(error?.code);
export const templateEditorCanMove = (model, baseline) => Boolean(model?.ref && !templateEditorDirty(model, baseline));
export const templateEditorAtLimit = (model, count, maximum = 200) => !model?.ref && count >= maximum;
// Pin sorting must not switch an open editor while its route is the list root.
export function templateEditorSelection(items, selection, previousRef) {
  const requested = items.find(item => item.ref === selection), previous = items.find(item => item.ref === previousRef);
  const fallback = requested || previous || items[0];
  return { selected: requested || (!selection ? fallback : null), defaultRef: fallback?.ref || '' };
}
