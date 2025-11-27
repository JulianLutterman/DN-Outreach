import { getWidgetHTML as getOld } from './ui-templates.old.js';
import { getWidgetHTML as getNew } from './ui-templates.js';

const oldHtml = getOld();
const newHtml = getNew();

if (oldHtml === newHtml) {
    console.log('SUCCESS: HTML matches exactly.');
} else {
    console.log('FAILURE: HTML does not match.');
    console.log('Length Old:', oldHtml.length);
    console.log('Length New:', newHtml.length);

    // Find first difference
    for (let i = 0; i < Math.max(oldHtml.length, newHtml.length); i++) {
        if (oldHtml[i] !== newHtml[i]) {
            console.log(`Difference at index ${i}:`);
            console.log(`Old: ...${oldHtml.substring(i - 20, i + 20)}...`);
            console.log(`New: ...${newHtml.substring(i - 20, i + 20)}...`);
            break;
        }
    }
}
