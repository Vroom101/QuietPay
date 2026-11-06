import type { Product } from "./products";

export function ProductImage({ product, className = "" }: { product: Product; className?: string }) {
  const style = product.imagePosition ? { backgroundPosition: product.imagePosition } : undefined;
  return <div className={`product-image ${product.imagePosition ? "catalog-image" : "lamp-image"} ${className}`} style={style} aria-hidden="true" />;
}
