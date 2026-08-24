# /app/src/R/lm.R
suppressWarnings(suppressMessages({
  library(jsonlite); library(stats)
}))
input <- suppressWarnings(fromJSON(file("stdin")))
x <- as.numeric(input$x); y <- as.numeric(input$y)
add_intercept <- isTRUE(input$add_intercept)

df <- data.frame(y=y, x=x)
if (add_intercept) {
  fit <- lm(y ~ x, data=df); coef <- unname(coef(fit))   # [Intercept], x
} else {
  fit <- lm(y ~ 0 + x, data=df); coef <- unname(coef(fit)) # x-only
}
rsq <- summary(fit)$r.squared
cat(toJSON(list(coef=coef, r2=unname(rsq), n=length(y)), auto_unbox = TRUE))