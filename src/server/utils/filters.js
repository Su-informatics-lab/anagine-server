/**
 * Convert Explorer-style filters into Guppy GraphQL filter format.
 */
export function getGQLFilter(filterObj = {}) {
  const facetsList = [];

  Object.keys(filterObj).forEach((field) => {
    const filterValues = filterObj[field];
    const fieldSplitted = field.split(".");
    const fieldName = fieldSplitted[fieldSplitted.length - 1];
    const combineMode = filterValues.__combineMode ? filterValues.__combineMode : "OR";

    const hasSelectedValues = filterValues.selectedValues && filterValues.selectedValues.length > 0;
    const hasRangeFilter =
      typeof filterValues.lowerBound !== "undefined" &&
      typeof filterValues.upperBound !== "undefined";

    let facetsPiece = {};
    if (hasSelectedValues && combineMode === "OR") {
      facetsPiece = { IN: { [fieldName]: filterValues.selectedValues } };
    } else if (hasSelectedValues && combineMode === "AND") {
      facetsPiece = { AND: [] };
      for (let i = 0; i < filterValues.selectedValues.length; i += 1) {
        facetsPiece.AND.push({ IN: { [fieldName]: [filterValues.selectedValues[i]] } });
      }
    } else if (hasRangeFilter) {
      facetsPiece = {
        AND: [
          { ">=": { [fieldName]: filterValues.lowerBound } },
          { "<=": { [fieldName]: filterValues.upperBound } },
        ],
      };
    } else if (filterValues.__combineMode && !hasSelectedValues && !hasRangeFilter) {
      return;
    } else if (hasSelectedValues) {
      throw new Error("Invalid filter object");
    }

    if (fieldSplitted.length > 1) {
      fieldSplitted.pop();
      facetsPiece = {
        nested: {
          path: fieldSplitted.join("."),
          ...facetsPiece,
        },
      };
    }
    facetsList.push(facetsPiece);
  });

  return { AND: facetsList };
}
